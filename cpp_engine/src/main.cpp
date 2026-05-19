#include <zmq.hpp>

#include <array>
#include <chrono>
#include <iostream>
#include <random>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace
{
    constexpr unsigned char ascii_tolower(unsigned char c)
    {
        return (c >= 'A' && c <= 'Z') ? static_cast<unsigned char>(c + ('a' - 'A')) : c;
    }

    bool contains_ascii_case_insensitive(std::string_view text, std::string_view needle)
    {
        if (needle.empty())
            return true;
        if (needle.size() > text.size())
            return false;

        for (std::size_t i = 0; i + needle.size() <= text.size(); ++i)
        {
            std::size_t j = 0;
            for (; j < needle.size(); ++j)
            {
                const unsigned char a = ascii_tolower(static_cast<unsigned char>(text[i + j]));
                const unsigned char b = ascii_tolower(static_cast<unsigned char>(needle[j]));
                if (a != b)
                    break;
            }
            if (j == needle.size())
                return true;
        }
        return false;
    }

    bool matches_macro_keywords(std::string_view headline)
    {
        // Hardcoded macro keyword list.
        constexpr std::array<std::string_view, 4> keywords{
            "FOMC",
            "CPI",
            "Rates",
            "Powell",
        };

        for (const auto kw : keywords)
        {
            if (contains_ascii_case_insensitive(headline, kw))
                return true;
        }
        return false;
    }

    std::string iso8601_utc_now()
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

    std::string json_escape(const std::string &s)
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
                if (static_cast<unsigned char>(c) < 0x20)
                {
                    // Control char; drop it to keep things simple for this demo.
                }
                else
                {
                    out += c;
                }
                break;
            }
        }
        return out;
    }

    std::string make_headline_json(const std::string &headline)
    {
        const std::string ts = iso8601_utc_now();
        return std::string("{") + "\"type\":\"headline\"," + "\"ts\":\"" + ts + "\"," + "\"headline\":\"" + json_escape(headline) + "\"" + "}";
    }
} // namespace

int main(int argc, char **argv)
{
    const std::string bind_endpoint = (argc >= 2) ? argv[1] : "tcp://127.0.0.1:5555";

    zmq::context_t ctx{1};
    zmq::socket_t pub{ctx, zmq::socket_type::pub};
    pub.bind(bind_endpoint);

    // Give subscribers a moment to connect (PUB drops messages until a SUB is ready).
    std::this_thread::sleep_for(std::chrono::milliseconds(250));

    const std::vector<std::string> headlines{
        "Fed raises rates by 25bps, signals higher-for-longer stance",
        "AAPL earnings beat as services revenue hits record",
        "US CPI comes in cooler than expected; futures rally",
        "Oil jumps 3% on supply disruption concerns in the Middle East",
        "NVDA announces new AI chips; shares pop in after-hours",
        "Treasury yields fall after weak jobs report; bond market rallies",
        "ECB holds rates steady; hints at possible summer cut",
        "TSLA deliveries miss estimates; margin pressure returns",
        "Gold climbs as dollar weakens and risk-off flows pick up",
        "China announces targeted stimulus; industrial metals rise",
        "MSFT cloud growth accelerates; upbeat guidance lifts tech",
        "Banking sector dips on renewed concerns over CRE exposure",
    };

    std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<std::size_t> pick(0, headlines.size() - 1);

    std::cout << "cpp_engine: publishing headlines (PUB) on " << bind_endpoint << "\n";
    std::cout << "cpp_engine: press Ctrl+C to stop\n";

    while (true)
    {
        const auto &headline = headlines[pick(rng)];
        if (matches_macro_keywords(headline))
        {
            const std::string payload = make_headline_json(headline);
            pub.send(zmq::buffer(payload), zmq::send_flags::none);
            std::cout << payload << "\n";
        }

        std::this_thread::sleep_for(std::chrono::seconds(2));
    }
}
