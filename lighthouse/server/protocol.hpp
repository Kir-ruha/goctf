#pragma once

#include <chrono>
#include <nlohmann/json.hpp>
#include <regex>
#include <stdexcept>
#include <string>
#include <string_view>

using json = nlohmann::json;

struct HttpError : std::runtime_error {
  int status;
  HttpError(int code, const std::string& message) : std::runtime_error(message), status(code) {}
};

inline long long epoch_now() {
  return std::chrono::duration_cast<std::chrono::seconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();
}

inline json object_body(const std::string& input) {
  auto body = json::parse(input, nullptr, false);
  if (!body.is_object()) throw HttpError(400, "need a JSON object");
  return body;
}

inline std::string text_field(const json& body, const char* name, const std::string& fallback) {
  if (!body.contains(name)) return fallback;
  if (!body[name].is_string()) throw HttpError(400, std::string(name) + " must be a string");
  return body[name].get<std::string>();
}

inline long long number_field(const json& body, const char* name, long long fallback,
                              long long low, long long high) {
  if (!body.contains(name)) return fallback;
  const auto& field = body[name];
  if (!field.is_number_integer() || field < low || field > high)
    throw HttpError(400, std::string(name) + " out of range");
  return field.get<long long>();
}

inline std::string label_field(const json& body, const std::string& fallback) {
  auto label = text_field(body, "label", fallback);
  if (!std::regex_match(label, std::regex("[A-Za-z0-9 _.-]{1,48}")))
    throw HttpError(400, "bad label");
  return label;
}

struct Envelope {
  std::string message;
  std::string topic;
  long long release_at;

  static Envelope read(const json& body) {
    auto encoded = text_field(body, "message", "");
    if (encoded.empty() || encoded.size() > 5464 || encoded.size() % 4)
      throw HttpError(400, "message must be 1..4096 bytes of base64 data");
    static constexpr std::string_view alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string message;
    message.reserve(encoded.size() / 4 * 3);
    for (size_t offset = 0; offset < encoded.size(); offset += 4) {
      unsigned values[4]{};
      unsigned padding = 0;
      for (size_t i = 0; i < 4; ++i) {
        auto c = encoded[offset + i];
        if (c == '=') {
          if (i < 2 || offset + 4 != encoded.size())
            throw HttpError(400, "invalid base64 message");
          ++padding;
        } else {
          if (padding) throw HttpError(400, "invalid base64 message");
          auto digit = alphabet.find(c);
          if (digit == std::string_view::npos) throw HttpError(400, "invalid base64 message");
          values[i] = static_cast<unsigned>(digit);
        }
      }
      if ((padding == 1 && (values[2] & 3)) || (padding == 2 && (values[1] & 15)))
        throw HttpError(400, "invalid base64 message");
      unsigned word = values[0] << 18 | values[1] << 12 | values[2] << 6 | values[3];
      message.push_back(static_cast<char>(word >> 16));
      if (padding < 2) message.push_back(static_cast<char>(word >> 8));
      if (!padding) message.push_back(static_cast<char>(word));
    }
    if (message.empty() || message.size() > 4096)
      throw HttpError(400, "message must be 1..4096 bytes of base64 data");
    auto topic = text_field(body, "topic", "inbox");
    if (!std::regex_match(topic, std::regex("[a-z0-9_.-]{1,32}")))
      throw HttpError(400, "bad topic");
    auto delay = number_field(body, "delay_ms", 0, 0, 60000);
    return {message, topic, epoch_now() + (delay + 999) / 1000};
  }
};
