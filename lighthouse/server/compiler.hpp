#pragma once

#include "legacy.hpp"
#include "recipe.hpp"
#include "util.hpp"
#include <wasmtime.h>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>

namespace filters {
namespace fs = std::filesystem;
inline constexpr auto work_root = "/srv/lighthouse/work";
struct Busy : std::runtime_error { Busy() : std::runtime_error("filter worker busy") {} };

class Slots {
  std::mutex lock_;
  std::condition_variable room_;
  int held_ = 0;
  int limit_;
public:
  explicit Slots(int limit) : limit_(limit) {}
  void acquire() {
    std::unique_lock guard(lock_);
    room_.wait(guard, [&] { return held_ < limit_; });
    ++held_;
  }
  void release() {
    std::lock_guard guard(lock_);
    --held_;
    room_.notify_one();
  }
};

class Slot {
  Slots& slots_;
public:
  explicit Slot(Slots& slots) : slots_(slots) { slots_.acquire(); }
  ~Slot() { slots_.release(); }
  Slot(const Slot&) = delete;
  Slot& operator=(const Slot&) = delete;
};

struct Artifact {
  bool ready = false;
  std::string path;
  std::string diagnostic;
  std::string listing;
};

inline void write_file(const fs::path& path, const std::string& bytes) {
  std::ofstream file(path, std::ios::binary);
  file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  file.close();
  if (!file) throw std::runtime_error("cannot write build file");
}

class Build {
  std::string code_;
  fs::path job_, input_, output_, log_, module_, listing_log_;
public:
  Artifact result;

  explicit Build(std::string code) : code_(std::move(code)) {
    job_ = fs::path(work_root) / random_hex(32);
    input_ = job_ / "filter.c";
    output_ = job_ / "out";
    log_ = job_ / "compiler.log";
    module_ = output_ / "filter.wasm";
    listing_log_ = job_ / "listing.log";
  }
  ~Build() {
    std::error_code error;
    if (!result.ready) fs::remove_all(job_, error);
    else {
      fs::remove_all(output_, error);
      fs::remove(input_, error);
      fs::remove(log_, error);
      fs::remove(listing_log_, error);
    }
  }

  void source() {
    if (!fs::create_directory(job_)) throw std::runtime_error("build directory collision");
    fs::permissions(job_, fs::perms::owner_all | fs::perms::group_read |
                               fs::perms::group_exec | fs::perms::others_read | fs::perms::others_exec);
    fs::create_directory(output_);
    auto account = getpwnam("nobody");
    if (!account || chown(output_.c_str(), account->pw_uid, account->pw_gid) ||
        chmod(output_.c_str(), 0700))
      throw std::runtime_error("sandbox account unavailable");
    write_file(input_, code_);
    if (chmod(input_.c_str(), 0444)) throw std::runtime_error("cannot publish source");
  }

  bool cc() {
    int status = legacy::system({
      "/usr/bin/timeout", "-k", "1s", "2s", "/usr/bin/prlimit",
      "--fsize=32768:32768", "--cpu=2:2", "--as=268435456:268435456",
      "/usr/bin/setpriv", "--reuid", "nobody", "--regid", "nogroup",
      "--clear-groups", "--no-new-privs", "--bounding-set", "-all",
      "/usr/bin/clang", "--target=wasm32-unknown-unknown",
      "-g", "-O0", "-nostdlib", "-fno-crash-diagnostics", "-fdebug-compilation-dir=.",
      "-ffile-prefix-map=" + job_.string() + "=.",
      "-fdebug-prefix-map=" + job_.string() + "=.",
      "-Wl,--threads=1", "-Wl,--no-entry", "-Wl,--export=filter",
      "-o", module_.string(), input_.string()
    }, log_.string());
    result.diagnostic = legacy::gets(log_.string());
    std::error_code error;
    if (status != 0 || !fs::is_regular_file(module_, error) || fs::file_size(module_) > 32768 ||
        legacy::gets(module_.string(), 8) != std::string("\0asm\1\0\0\0", 8)) {
      if (result.diagnostic.empty()) result.diagnostic = "compiler failed";
      return false;
    }
    return true;
  }

  void listing() {
    auto artifact = job_ / "filter.wasm";
    fs::copy_file(module_, artifact);
    result.path = artifact.string();
    int status = legacy::system({
      "/usr/bin/timeout", "-k", "1s", "1s", "/usr/bin/prlimit",
      "--fsize=32768:32768", "--cpu=1:1", "--as=268435456:268435456",
      "/usr/bin/setpriv", "--reuid", "nobody", "--regid", "nogroup",
      "--clear-groups", "--no-new-privs", "--bounding-set", "-all",
      "/usr/bin/llvm-objdump", "-S", result.path
    }, listing_log_.string());
    result.listing = legacy::gets(listing_log_.string(), 8192);
    if (status != 0 && result.listing.empty()) result.listing = "listing unavailable";
    result.ready = true;
  }
};

inline Artifact compile(const std::string& source) {
  static Slots slots(4);
  Slot slot(slots);
  Build build(source);
  recipe::run(recipe::filter, build);
  return build.result;
}

inline bool accepts(const std::string& wasm, size_t length) {
  if (wasm.empty()) return true;
  static Slots slots(4);
  Slot slot(slots);
  using Engine = std::unique_ptr<wasm_engine_t, decltype(&wasm_engine_delete)>;
  static Engine engine([] {
    auto config = wasm_config_new();
    wasmtime_config_consume_fuel_set(config, true);
    wasmtime_config_max_wasm_stack_set(config, 64 * 1024);
    return wasm_engine_new_with_config(config);
  }(), wasm_engine_delete);
  using Store = std::unique_ptr<wasmtime_store_t, decltype(&wasmtime_store_delete)>;
  using Module = std::unique_ptr<wasmtime_module_t, decltype(&wasmtime_module_delete)>;
  using Error = std::unique_ptr<wasmtime_error_t, decltype(&wasmtime_error_delete)>;
  using Trap = std::unique_ptr<wasm_trap_t, decltype(&wasm_trap_delete)>;
  struct Cache {
    std::string path;
    Module module{nullptr, wasmtime_module_delete};
  };
  static thread_local Cache cached;
  Error error(nullptr, wasmtime_error_delete);
  if (cached.path != wasm) {
    auto bytes = legacy::gets(wasm, 32769);
    if (bytes.size() > 32768 || bytes.size() < 8) return false;
    wasmtime_module_t* compiled = nullptr;
    error.reset(wasmtime_module_new(engine.get(), reinterpret_cast<const uint8_t*>(bytes.data()),
                                    bytes.size(), &compiled));
    if (error) return false;
    cached.module.reset(compiled);
    cached.path = wasm;
  }
  Store store(wasmtime_store_new(engine.get(), nullptr, nullptr), wasmtime_store_delete);
  wasmtime_store_limiter(store.get(), 128 * 1024, 128, 1, 1, 1);
  auto context = wasmtime_store_context(store.get());
  error.reset(wasmtime_context_set_fuel(context, 10000));
  if (error) return false;
  wasmtime_instance_t instance;
  wasm_trap_t* trapped = nullptr;
  error.reset(wasmtime_instance_new(context, cached.module.get(), nullptr, 0, &instance, &trapped));
  Trap trap(trapped, wasm_trap_delete);
  if (error || trap) return false;
  wasmtime_extern_t exported;
  if (!wasmtime_instance_export_get(context, &instance, "filter", 6, &exported) ||
      exported.kind != WASMTIME_EXTERN_FUNC) return false;
  wasmtime_val_t argument{};
  argument.kind = WASMTIME_I32;
  argument.of.i32 = static_cast<int32_t>(length);
  wasmtime_val_t result{};
  trapped = nullptr;
  error.reset(wasmtime_func_call(context, &exported.of.func, &argument, 1, &result, 1, &trapped));
  trap.reset(trapped);
  return !error && !trap && result.kind == WASMTIME_I32 && result.of.i32 != 0;
}

}
