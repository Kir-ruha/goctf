#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace recipe {

enum class Op : uint8_t { source = 1, cc, listing };
struct Program {
  std::array<Op, 3> code{};
  size_t size = 0;
};

consteval Program compile(std::string_view text) {
  Program program;
  unsigned effects = 0;
  while (!text.empty()) {
    auto end = text.find('|');
    auto word = text.substr(0, end);
    while (!word.empty() && word.front() == ' ') word.remove_prefix(1);
    while (!word.empty() && word.back() == ' ') word.remove_suffix(1);
    Op op;
    unsigned needs, gives;
    if (word == "source") { op = Op::source; needs = 0; gives = 1; }
    else if (word == "cc") { op = Op::cc; needs = 1; gives = 2; }
    else if (word == "listing") { op = Op::listing; needs = 2; gives = 4; }
    else throw "unknown recipe stage";
    if ((effects & needs) != needs || (effects & gives) || program.size == program.code.size())
      throw "recipe stages out of order or repeated";
    effects |= gives;
    program.code[program.size++] = op;
    if (end == std::string_view::npos) break;
    text.remove_prefix(end + 1);
    if (text.empty()) throw "empty recipe stage";
  }
  if (effects != 7) throw "incomplete filter recipe";
  return program;
}

inline constexpr auto filter = compile("source | cc | listing");

template <class Build>
void run(const Program& program, Build& build) {
  for (size_t pc = 0; pc < program.size; ++pc) {
    switch (program.code[pc]) {
      case Op::source: build.source(); break;
      case Op::cc: if (!build.cc()) return; break;
      case Op::listing: build.listing(); break;
    }
  }
}

}
