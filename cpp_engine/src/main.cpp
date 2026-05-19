#include <zmq.hpp>

#include <iostream>

int main()
{
    zmq::context_t ctx{1};
    zmq::socket_t sock{ctx, zmq::socket_type::req};

    std::cout << "cpp_engine: ZeroMQ + cppzmq initialized successfully\n";
    (void)sock;

    return 0;
}
