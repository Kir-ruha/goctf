#pragma once

#include <cerrno>
#include <ctime>
#include <stdexcept>
#include <string>
#include <sys/random.h>

inline std::string random_hex(size_t count) {
  std::string bytes(count, '\0');
  size_t offset = 0;
  while (offset < count) {
    auto got = getrandom(bytes.data() + offset, count - offset, 0);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) throw std::runtime_error("random source failed");
    offset += static_cast<size_t>(got);
  }
  for (auto& byte : bytes) byte = "0123456789abcdef"[static_cast<unsigned char>(byte) & 15];
  return bytes;
}

inline std::string uuid() {
  auto value = random_hex(32);
  value[12] = '4';
  value[16] = "89ab"[static_cast<unsigned char>(value[16]) & 3];
  return value.substr(0,8) + "-" + value.substr(8,4) + "-" + value.substr(12,4) +
         "-" + value.substr(16,4) + "-" + value.substr(20);
}

inline std::string utc_now() {
  auto time = std::time(nullptr);
  std::tm utc{};
  gmtime_r(&time, &utc);
  char text[32];
  std::strftime(text, sizeof(text), "%FT%TZ", &utc);
  return text;
}
