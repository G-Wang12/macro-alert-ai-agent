cmake_minimum_required(VERSION 3.22)

project(cpp_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

# cppzmq = C++ bindings for ZeroMQ (header-only)
set(CPPZMQ_BUILD_TESTS OFF CACHE BOOL "Build cppzmq tests/examples" FORCE)
FetchContent_Declare(
  cppzmq
  GIT_REPOSITORY https://github.com/zeromq/cppzmq.git
  GIT_TAG v4.10.0
)
FetchContent_MakeAvailable(cppzmq)

add_executable(cpp_engine
  src/main.cpp
)

target_compile_features(cpp_engine PRIVATE cxx_std_20)

# cppzmq provides the <zmq.hpp> header and links against libzmq via its CMake config.
target_link_libraries(cpp_engine PRIVATE
  cppzmq
)
