#pragma once

#include <sqlite3.h>
#include <stdexcept>
#include <string>
#include <string_view>

class Statement {
  sqlite3_stmt* stmt_ = nullptr;
public:
  Statement(sqlite3* db, const char* sql) {
    if (sqlite3_prepare_v2(db, sql, -1, &stmt_, nullptr) != SQLITE_OK)
      throw std::runtime_error(sqlite3_errmsg(db));
  }
  ~Statement() { sqlite3_finalize(stmt_); }
  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;
  Statement& bind(int index, std::string_view value) {
    if (sqlite3_bind_text(stmt_, index, value.data(), static_cast<int>(value.size()), SQLITE_TRANSIENT) != SQLITE_OK)
      throw std::runtime_error("SQL text binding failed");
    return *this;
  }
  Statement& bind(int index, long long value) {
    if (sqlite3_bind_int64(stmt_, index, value) != SQLITE_OK)
      throw std::runtime_error("SQL integer binding failed");
    return *this;
  }
  bool next() {
    int rc = sqlite3_step(stmt_);
    if (rc == SQLITE_ROW) return true;
    if (rc == SQLITE_DONE) return false;
    throw std::runtime_error(sqlite3_errmsg(sqlite3_db_handle(stmt_)));
  }
  std::string text(int column) const {
    auto p = reinterpret_cast<const char*>(sqlite3_column_text(stmt_, column));
    return p ? std::string(p, sqlite3_column_bytes(stmt_, column)) : std::string{};
  }
  long long number(int column) const { return sqlite3_column_int64(stmt_, column); }
};

inline void execute(sqlite3* db, const char* sql) {
  if (sqlite3_exec(db, sql, nullptr, nullptr, nullptr) != SQLITE_OK)
    throw std::runtime_error(sqlite3_errmsg(db));
}

class Transaction {
  sqlite3* db_;
  bool committed_ = false;
public:
  explicit Transaction(sqlite3* db) : db_(db) { execute(db_, "BEGIN IMMEDIATE"); }
  ~Transaction() { if (!committed_) sqlite3_exec(db_, "ROLLBACK", nullptr, nullptr, nullptr); }
  void commit() { execute(db_, "COMMIT"); committed_ = true; }
};
