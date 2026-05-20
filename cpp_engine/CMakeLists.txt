cmake_minimum_required(VERSION 3.22)

project(cpp_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

# std::thread (LiveRestDataSource worker, FilterSubscriber) needs pthreads on Linux.
find_package(Threads REQUIRED)

# cppzmq = C++ bindings for ZeroMQ (header-only)
set(CPPZMQ_BUILD_TESTS OFF CACHE BOOL "Build cppzmq tests/examples" FORCE)
FetchContent_Declare(
  cppzmq
  GIT_REPOSITORY https://github.com/zeromq/cppzmq.git
  GIT_TAG v4.10.0
)
FetchContent_MakeAvailable(cppzmq)

# cpp-httplib = header-only HTTP/HTTPS client, used to poll the Finnhub REST API.
# HTTPLIB_REQUIRE_OPENSSL forces find_package(OpenSSL) and fails configure if it's
# missing; when found, cpp-httplib defines CPPHTTPLIB_OPENSSL_SUPPORT and links
# OpenSSL on the httplib::httplib target, enabling https:// requests.
set(HTTPLIB_REQUIRE_OPENSSL ON CACHE BOOL "Require OpenSSL for cpp-httplib HTTPS" FORCE)
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG v0.18.3
)
FetchContent_MakeAvailable(httplib)

# nlohmann/json = header-only JSON parser, used to decode Finnhub news payloads.
set(JSON_BuildTests OFF CACHE INTERNAL "")
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
)
FetchContent_MakeAvailable(nlohmann_json)

add_executable(cpp_engine
  src/main.cpp
)

target_compile_features(cpp_engine PRIVATE cxx_std_20)

# cppzmq provides the <zmq.hpp> header and links against libzmq via its CMake config.
# httplib provides <httplib.h> with OpenSSL-backed HTTPS support linked in.
# nlohmann_json provides <nlohmann/json.hpp>.
target_link_libraries(cpp_engine PRIVATE
  cppzmq
  httplib::httplib
  nlohmann_json::nlohmann_json
  Threads::Threads
)
