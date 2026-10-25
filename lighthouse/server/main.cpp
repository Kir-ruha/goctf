#include <httplib.h>

#include "chronicle.hpp"
#include "compiler.hpp"
#include "crypto.hpp"
#include "database.hpp"
#include "protocol.hpp"
#include "util.hpp"

#include <filesystem>
#include <iostream>
#include <mutex>
#include <vector>

namespace fs = std::filesystem;
static sqlite3* db = nullptr;
static std::mutex db_lock;

static void reply(httplib::Response& response, int status, const json& body) {
  response.status = status;
  response.set_content(body.dump(-1, ' ', false, json::error_handler_t::replace), "application/json");
}

template <class Handler>
static auto endpoint(Handler handler) {
  return [handler](const httplib::Request& request, httplib::Response& response) {
    try {
      handler(request, response);
    } catch (const HttpError& error) {
      reply(response, error.status, {{"error", error.what()}});
    } catch (const filters::Busy& error) {
      reply(response, 429, {{"error", error.what()}});
    } catch (const json::exception&) {
      reply(response, 400, {{"error", "bad field type"}});
    } catch (const std::exception& error) {
      std::cerr << "request failed: " << error.what() << '\n';
      reply(response, 500, {{"error", "service error"}});
    }
  };
}

static void require_queue(const std::string& id) {
  Statement query(db, "SELECT 1 FROM queues WHERE id=?");
  if (!query.bind(1, id).next()) throw HttpError(404, "queue not found");
}

static void require_key(const httplib::Request& request) {
  Statement query(db, "SELECT 1 FROM queues WHERE id=? AND read_key=?");
  query.bind(1, request.matches[1].str()).bind(2, request.get_header_value("X-Queue-Key"));
  if (!query.next()) throw HttpError(403, "bad queue key");
}

static json message_row(const Statement& query) {
  return {{"id", query.number(0)}, {"topic", query.text(1)}, {"ciphertext", query.text(2)}};
}

static void initialize() {
  fs::create_directories("/data");
  fs::create_directories("/var/log/lighthouse");
  fs::create_directories(filters::work_root);
  if (chmod("/data", 0700) || chmod("/var/log/lighthouse", 0755) ||
      chmod(filters::work_root, 0711))
    throw std::runtime_error("cannot set storage permissions");
  if (sqlite3_open("/data/lighthouse.db", &db) != SQLITE_OK)
    throw std::runtime_error("cannot open database");
  execute(db, R"SQL(
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS queues(
      id TEXT PRIMARY KEY, read_key TEXT NOT NULL,
      wasm_path TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT 'untitled',
      retention_seconds INTEGER NOT NULL DEFAULT 3600, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES queues(id),
      ciphertext TEXT NOT NULL, topic TEXT NOT NULL DEFAULT 'inbox',
      not_before INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 2147483647,
      read_at INTEGER, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS filter_revisions(
      id INTEGER PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES queues(id),
      label TEXT NOT NULL, state TEXT NOT NULL, wasm_path TEXT NOT NULL DEFAULT '',
      compiler_output TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
      listing TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_by_queue ON messages(queue_id,id);
    CREATE INDEX IF NOT EXISTS revisions_by_queue ON filter_revisions(queue_id,id DESC);
  )SQL");
  bool has_read_at = false;
  {
    Statement columns(db, "PRAGMA table_info(messages)");
    while (columns.next())
      if (columns.text(1) == "read_at") has_read_at = true;
  }
  if (!has_read_at) execute(db, "ALTER TABLE messages ADD COLUMN read_at INTEGER");
  bool has_source = false, has_listing = false;
  {
    Statement columns(db, "PRAGMA table_info(filter_revisions)");
    while (columns.next()) {
      if (columns.text(1) == "source") has_source = true;
      if (columns.text(1) == "listing") has_listing = true;
    }
  }
  if (!has_source) execute(db, "ALTER TABLE filter_revisions ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  if (!has_listing) execute(db, "ALTER TABLE filter_revisions ADD COLUMN listing TEXT NOT NULL DEFAULT ''");
}

static void queue_routes(httplib::Server& server) {
  server.Post("/api/queues", endpoint([](const auto& request, auto& response) {
    auto body = object_body(request.body);
    auto label = label_field(body, "untitled");
    auto retention = number_field(body, "retention_seconds", 3600, 60, 604800);
    auto id = uuid(), key = random_hex(48), created = utc_now();
    std::lock_guard guard(db_lock);
    Statement insert(db, "INSERT INTO queues(id,read_key,label,retention_seconds,created_at) VALUES(?,?,?,?,?)");
    insert.bind(1, id).bind(2, key).bind(3, label).bind(4, retention).bind(5, created).next();
    reply(response, 201, {{"id", id}, {"read_key", key}, {"label", label},
                         {"retention_seconds", retention}, {"created_at", created}});
  }));

  server.Get(R"(/api/queues/([0-9a-f-]{36})$)", endpoint([](const auto& request, auto& response) {
    auto id = request.matches[1].str();
    auto moment = epoch_now();
    std::lock_guard guard(db_lock);
    Statement query(db, R"SQL(
      SELECT q.created_at,q.wasm_path,q.label,q.retention_seconds,COUNT(m.id),
              COALESCE(SUM(m.not_before<=? AND m.expires_at>? AND m.read_at IS NULL),0)
      FROM queues q LEFT JOIN messages m ON m.queue_id=q.id WHERE q.id=? GROUP BY q.id
    )SQL");
    query.bind(1, moment).bind(2, moment).bind(3, id);
    if (!query.next()) throw HttpError(404, "queue not found");
    reply(response, 200, {{"id", id}, {"created_at", query.text(0)}, {"label", query.text(2)},
                         {"retention_seconds", query.number(3)}, {"filter_installed", !query.text(1).empty()},
                         {"stored_count", query.number(4)}, {"ready_count", query.number(5)}});
  }));
}

static void filter_routes(httplib::Server& server) {
  server.Post(R"(/api/queues/([0-9a-f-]{36})/filter)", endpoint([](const auto& request, auto& response) {
    auto id = request.matches[1].str();
    auto body = object_body(request.body);
    auto source = text_field(body, "source", "");
    if (source.empty() || source.size() > 8192 || source.find('\0') != std::string::npos)
      throw HttpError(400, "need 1..8192 bytes of C source");
    auto label = label_field(body, "unnamed");
    {
      std::lock_guard guard(db_lock);
      require_queue(id);
    }
    auto artifact = filters::compile(source);
    auto state = artifact.ready ? "ready" : "rejected";
    long long revision;
    {
      std::lock_guard guard(db_lock);
      Transaction transaction(db);
      Statement insert(db, R"SQL(
        INSERT INTO filter_revisions(queue_id,label,state,wasm_path,compiler_output,source,listing,created_at)
        VALUES(?,?,?,?,?,?,?,?)
      )SQL");
      insert.bind(1, id).bind(2, label).bind(3, state).bind(4, artifact.path)
            .bind(5, artifact.diagnostic).bind(6, source).bind(7, artifact.listing)
            .bind(8, utc_now()).next();
      revision = sqlite3_last_insert_rowid(db);
      Statement old(db, R"SQL(
        SELECT r.id,r.wasm_path FROM filter_revisions r JOIN queues q ON q.id=r.queue_id
        WHERE r.queue_id=? AND (r.wasm_path='' OR r.wasm_path<>q.wasm_path)
        AND r.id NOT IN (SELECT id FROM filter_revisions WHERE queue_id=? ORDER BY id DESC LIMIT 16)
      )SQL");
      old.bind(1, id).bind(2, id);
      std::vector<long long> obsolete_ids;
      std::vector<std::string> obsolete;
      while (old.next()) {
        obsolete_ids.push_back(old.number(0));
        if (!old.text(1).empty()) obsolete.push_back(old.text(1));
      }
      for (auto revision_id : obsolete_ids) {
        Statement erase(db, "DELETE FROM filter_revisions WHERE id=?");
        erase.bind(1, revision_id).next();
      }
      transaction.commit();
      for (const auto& path : obsolete) {
        std::error_code error;
        fs::remove_all(fs::path(path).parent_path(), error);
      }
    }
    reply(response, artifact.ready ? 200 : 422,
           {{"ok", artifact.ready}, {"compiler", artifact.diagnostic}, {"listing", artifact.listing},
           {"revision", revision}, {"state", state}, {"active", false},
           {"abi", "int filter(int encrypted_length): nonzero accepts"}});
  }));

  server.Get(R"(/api/queues/([0-9a-f-]{36})/filters)", endpoint([](const auto& request, auto& response) {
    auto id = request.matches[1].str();
    std::lock_guard guard(db_lock);
    require_queue(id);
    Statement query(db, R"SQL(
      SELECT r.id,r.label,r.state,r.created_at,r.wasm_path=q.wasm_path AND r.wasm_path<>''
      FROM filter_revisions r JOIN queues q ON q.id=r.queue_id
      WHERE r.queue_id=? ORDER BY r.id DESC LIMIT 20
    )SQL");
    query.bind(1, id);
    auto history = json::array();
    while (query.next())
      history.push_back({{"revision", query.number(0)}, {"label", query.text(1)},
                         {"state", query.text(2)}, {"created_at", query.text(3)},
                         {"active", query.number(4) != 0}});
    reply(response, 200, {{"filters", history}});
  }));

  server.Get(R"(/api/queues/([0-9a-f-]{36})/filters/([0-9]{1,18})$)",
             endpoint([](const auto& request, auto& response) {
    std::lock_guard guard(db_lock);
    require_key(request);
    Statement query(db, R"SQL(
      SELECT r.label,r.state,r.created_at,r.source,r.compiler_output,r.listing,
             r.wasm_path=q.wasm_path AND r.wasm_path<>''
      FROM filter_revisions r JOIN queues q ON q.id=r.queue_id
      WHERE r.queue_id=? AND r.id=?
    )SQL");
    query.bind(1, request.matches[1].str()).bind(2, std::stoll(request.matches[2].str()));
    if (!query.next()) throw HttpError(404, "revision not found");
    reply(response, 200, {{"revision", std::stoll(request.matches[2].str())},
                          {"label", query.text(0)}, {"state", query.text(1)},
                          {"created_at", query.text(2)}, {"source", query.text(3)},
                          {"compiler", query.text(4)}, {"listing", query.text(5)},
                          {"active", query.number(6) != 0}});
  }));

  server.Post(R"(/api/queues/([0-9a-f-]{36})/filters/([0-9]{1,18})/activate)",
              endpoint([](const auto& request, auto& response) {
    auto id = request.matches[1].str();
    auto revision = std::stoll(request.matches[2].str());
    std::lock_guard guard(db_lock);
    require_key(request);
    Statement query(db, "SELECT wasm_path FROM filter_revisions WHERE id=? AND queue_id=? AND state='ready'");
    query.bind(1, revision).bind(2, id);
    if (!query.next()) throw HttpError(404, "ready revision not found");
    Statement update(db, "UPDATE queues SET wasm_path=? WHERE id=?");
    update.bind(1, query.text(0)).bind(2, id).next();
    reply(response, 200, {{"active_revision", revision}});
  }));
}

static void message_routes(httplib::Server& server) {
  server.Post(R"(/api/queues/([0-9a-f-]{36})/messages)", endpoint([](const auto& request, auto& response) {
    auto id = request.matches[1].str();
    auto letter = Envelope::read(object_body(request.body));
    std::string wasm, created, key;
    long long retention;
    {
      std::lock_guard guard(db_lock);
      Statement query(db, "SELECT wasm_path,created_at,retention_seconds,read_key FROM queues WHERE id=?");
      if (!query.bind(1, id).next()) throw HttpError(404, "queue not found");
      wasm = query.text(0);
      created = query.text(1);
      retention = query.number(2);
      key = query.text(3);
    }
    auto cipher = crypto::seal(key, letter.message);
    if (!filters::accepts(wasm, cipher.size()))
      throw HttpError(403, "message rejected by filter");
    auto instant = utc_now();
    {
      std::lock_guard guard(db_lock);
      Transaction transaction(db);
      Statement prune(db, "DELETE FROM messages WHERE queue_id=? AND expires_at<=?");
      prune.bind(1, id).bind(2, epoch_now()).next();
      Statement insert(db, R"SQL(
        INSERT INTO messages(queue_id,ciphertext,topic,not_before,expires_at,created_at) VALUES(?,?,?,?,?,?)
      )SQL");
      insert.bind(1, id).bind(2, cipher).bind(3, letter.topic).bind(4, letter.release_at)
            .bind(5, epoch_now() + retention).bind(6, instant).next();
      chronicle::append(created, id, letter.topic, cipher, instant);
      transaction.commit();
    }
    reply(response, 201, {{"queued", true}, {"encrypted_length", cipher.size()},
                         {"topic", letter.topic}, {"release_at", letter.release_at}});
  }));

  server.Get(R"(/api/queues/([0-9a-f-]{36})/messages)", endpoint([](const auto& request, auto& response) {
    auto show_read = request.has_param("show_read") && request.get_param_value("show_read") == "true";
    std::lock_guard guard(db_lock);
    require_key(request);
    auto moment = epoch_now();
    Transaction transaction(db);
    Statement query(db, R"SQL(
      SELECT id,topic,ciphertext FROM messages
      WHERE queue_id=? AND not_before<=? AND expires_at>?
        AND (? OR read_at IS NULL) ORDER BY id
    )SQL");
    query.bind(1, request.matches[1].str()).bind(2, moment).bind(3, moment).bind(4, show_read ? 1LL : 0LL);
    auto messages = json::array();
    while (query.next()) messages.push_back(message_row(query));
    if (!show_read) {
      Statement mark(db, R"SQL(
        UPDATE messages SET read_at=? WHERE queue_id=? AND not_before<=?
          AND expires_at>? AND read_at IS NULL
      )SQL");
      mark.bind(1, moment).bind(2, request.matches[1].str()).bind(3, moment).bind(4, moment).next();
    }
    transaction.commit();
    reply(response, 200, {{"messages", messages}});
  }));
}

int main() {
  try {
    initialize();
    httplib::Server server;
    server.set_payload_max_length(32768);
    server.set_pre_routing_handler([](const httplib::Request& request, httplib::Response& response) {
      if (request.has_header("Range")) {
        reply(response, 400, {{"error", "range requests are not supported"}});
        return httplib::Server::HandlerResponse::Handled;
      }
      return httplib::Server::HandlerResponse::Unhandled;
    });
    server.Get("/api/health", endpoint([](const auto&, auto& response) {
      reply(response, 200, {{"status", "ok"}});
    }));
    queue_routes(server);
    filter_routes(server);
    message_routes(server);
    server.set_mount_point("/", "/srv/lighthouse/public");
    bool listening = server.listen("0.0.0.0", 8080);
    sqlite3_close(db);
    return listening ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << "startup failed: " << error.what() << '\n';
    if (db) sqlite3_close(db);
    return 1;
  }
}
