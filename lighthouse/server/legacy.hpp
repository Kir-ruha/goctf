#pragma once

#include <cerrno>
#include <fcntl.h>
#include <fstream>
#include <spawn.h>
#include <stdexcept>
#include <string>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

extern char** environ;

namespace legacy {

inline std::string gets(const std::string& path, size_t limit = 65536) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return {};
  std::string data(limit, '\0');
  file.read(data.data(), static_cast<std::streamsize>(data.size()));
  data.resize(static_cast<size_t>(file.gcount()));
  return data;
}

inline int system(const std::vector<std::string>& arguments, const std::string& output) {
  if (arguments.empty() || arguments.front().empty() || arguments.front()[0] != '/')
    throw std::runtime_error("need an absolute executable path");
  if (output.find('\0') != std::string::npos) throw std::runtime_error("NUL in output path");
  std::vector<char*> argv;
  for (const auto& argument : arguments) {
    if (argument.find('\0') != std::string::npos) throw std::runtime_error("NUL in argument");
    argv.push_back(const_cast<char*>(argument.c_str()));
  }
  argv.push_back(nullptr);
  posix_spawn_file_actions_t actions;
  if (posix_spawn_file_actions_init(&actions)) throw std::runtime_error("spawn setup failed");
  int error = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  if (!error) error = posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, output.c_str(),
                                                    O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (!error) error = posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDERR_FILENO);
  pid_t child = -1;
  if (!error) error = posix_spawn(&child, argv[0], &actions, nullptr, argv.data(), environ);
  posix_spawn_file_actions_destroy(&actions);
  if (error) throw std::runtime_error("cannot start tool");
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) throw std::runtime_error("cannot wait for tool");
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128;
}

}
