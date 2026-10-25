#pragma once

#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

namespace crypto {

inline uint8_t g(unsigned a, unsigned b, unsigned carry) {
  unsigned value = (a + b + carry) & 255;
  return static_cast<uint8_t>((value << 2 | value >> 6) & 255);
}

inline uint32_t f(uint32_t x) {
  unsigned a = x >> 24, b = (x >> 16) & 255, c = (x >> 8) & 255, d = x & 255;
  unsigned y1 = g(a ^ b, c ^ d, 1);
  unsigned y2 = g(c ^ d, y1, 0);
  return g(a, y1, 0) << 24 | y1 << 16 | y2 << 8 | g(d, y2, 1);
}

inline uint32_t fk(uint32_t x, uint32_t y) {
  unsigned a = x >> 24, b = (x >> 16) & 255, c = (x >> 8) & 255, d = x & 255;
  unsigned u = y >> 24, v = (y >> 16) & 255, w = (y >> 8) & 255, z = y & 255;
  unsigned middle1 = g(a ^ b, (c ^ d) ^ u, 1);
  unsigned middle2 = g(c ^ d, middle1 ^ v, 0);
  return g(a, middle1 ^ w, 0) << 24 | middle1 << 16 | middle2 << 8 | g(d, middle2 ^ z, 1);
}

inline uint64_t block(uint64_t value, const std::array<uint32_t, 6>& k, bool decrypt = false) {
  uint32_t left = static_cast<uint32_t>(value >> 32), right = static_cast<uint32_t>(value);
  if (decrypt) {
    uint32_t x = left, y = right ^ left;
    for (int round = 3; round >= 1; --round) {
      uint32_t next = x ^ f(y ^ k[round]);
      x = y;
      y = next;
    }
    uint32_t initial = x ^ f(y ^ k[0]);
    return static_cast<uint64_t>(initial ^ k[4]) << 32 | (initial ^ y ^ k[5]);
  }
  left ^= k[4];
  right ^= k[5];
  uint32_t x = left ^ right, y = left ^ f(x ^ k[0]);
  for (int round = 1; round <= 2; ++round) {
    uint32_t next = x ^ f(y ^ k[round]);
    x = y;
    y = next;
  }
  uint32_t last = x ^ f(y ^ k[3]);
  return static_cast<uint64_t>(last) << 32 | (last ^ y);
}

inline std::array<uint32_t, 6> schedule(std::string_view secret) {
  if (secret.size() != 48) throw std::runtime_error("bad read secret");
  auto digit = [](char c) -> uint8_t {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    throw std::runtime_error("bad read secret");
  };
  std::array<uint32_t, 6> material{};
  for (size_t i = 0; i < material.size(); ++i) {
    uint32_t word = 0;
    for (size_t j = 0; j < 4; ++j) {
      auto byte = digit(secret[8 * i + 2 * j]) << 4 | digit(secret[8 * i + 2 * j + 1]);
      word = word << 8 | byte;
    }
    material[i] = word;
  }
  uint32_t left = material[0], right = material[1], previous = material[5];
  std::array<uint16_t, 12> words{};
  for (size_t i = 0; i < 6; ++i) {
    auto next = fk(left, right ^ previous ^ material[i]);
    previous = left;
    left = right;
    right = next;
    words[2 * i] = static_cast<uint16_t>(next >> 16);
    words[2 * i + 1] = static_cast<uint16_t>(next);
  }
  auto whitening = [&](size_t i) { return static_cast<uint32_t>(words[i]) << 16 | words[i + 1]; };
  uint32_t output_left = whitening(8) ^ material[2], output_right = whitening(10) ^ material[3];
  std::array<uint32_t, 6> keys{};
  for (size_t i = 0; i < 4; ++i) {
    uint32_t round = static_cast<uint32_t>(words[i] >> 8) << 16 |
                     static_cast<uint32_t>(words[i] & 255) << 8;
    keys[i] = round ^ output_left ^ (i % 2 ? output_right : 0) ^ material[i];
  }
  keys[4] = whitening(4) ^ output_left ^ output_right ^ material[4];
  keys[5] = whitening(6) ^ output_right ^ material[5];
  return keys;
}

inline std::string seal(std::string_view secret, std::string_view plain) {
  std::string padded(plain);
  auto padding = 8 - (padded.size() % 8);
  padded.append(padding, static_cast<char>(padding));
  auto keys = schedule(secret);
  std::string result;
  result.reserve(padded.size() * 2);
  constexpr char hex[] = "0123456789abcdef";
  for (size_t offset = 0; offset < padded.size(); offset += 8) {
    uint64_t value = 0;
    for (size_t i = 0; i < 8; ++i)
      value = value << 8 | static_cast<unsigned char>(padded[offset+i]);
    value = block(value, keys);
    for (int shift = 60; shift >= 0; shift -= 4) result.push_back(hex[(value >> shift) & 15]);
  }
  return result;
}

}
