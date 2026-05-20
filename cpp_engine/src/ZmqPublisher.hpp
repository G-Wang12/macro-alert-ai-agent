#pragma once

#include <zmq.hpp>

#include <chrono>
#include <cstdio>
#include <ctime>
#include <string>
#include <string_view>

class ZmqPublisher
{
public:
    explicit ZmqPublisher(std::string_view endpoint)
        : ctx_{1}, sock_{ctx_, zmq::socket_type::pub}
    {
        sock_.bind(std::string(endpoint));
    }

    ZmqPublisher(const ZmqPublisher &) = delete;
    ZmqPublisher &operator=(const ZmqPublisher &) = delete;

    void publishHeadline(std::string_view headline)
    {
        const std::string payload = build_headline_json(headline);
        sock_.send(zmq::buffer(payload), zmq::send_flags::none);
    }

private:
    static std::string iso8601_utc_now()
    {
        using clock = std::chrono::system_clock;
        const auto now = clock::now();
        const auto t = clock::to_time_t(now);

        std::tm tm{};
#if defined(_WIN32)
        gmtime_s(&tm, &t);
#else
        gmtime_r(&t, &tm);
#endif

        char buf[32];
        std::snprintf(
            buf,
            sizeof(buf),
            "%04d-%02d-%02dT%02d:%02d:%02dZ",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec);
        return std::string(buf);
    }

    static std::string json_escape(std::string_view s)
    {
        std::string out;
        out.reserve(s.size() + 8);
        for (const char c : s)
        {
            switch (c)
            {
            case '\\':
                out += "\\\\";
                break;
            case '"':
                out += "\\\"";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (static_cast<unsigned char>(c) >= 0x20)
                    out += c;
                break;
            }
        }
        return out;
    }

    static std::string build_headline_json(std::string_view headline)
    {
        const std::string ts = iso8601_utc_now();
        std::string out;
        out.reserve(headline.size() + ts.size() + 32);
        out += "{\"type\":\"headline\",\"ts\":\"";
        out += ts;
        out += "\",\"headline\":\"";
        out += json_escape(headline);
        out += "\"}";
        return out;
    }

    zmq::context_t ctx_;
    zmq::socket_t sock_;
};
