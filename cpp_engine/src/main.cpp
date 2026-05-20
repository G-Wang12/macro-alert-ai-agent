#include "DotEnv.hpp"
#include "FilterSubscriber.hpp"
#include "IMarketDataSource.hpp"
#include "LiveRestDataSource.hpp"
#include "MacroFilter.hpp"
#include "SharedFilter.hpp"
#include "SimulatedDataSource.hpp"
#include "ZmqPublisher.hpp"

#include <chrono>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>

namespace
{
    enum class SourceMode
    {
        Simulate,
        Live,
    };

    struct CliArgs
    {
        SourceMode mode = SourceMode::Simulate;
        std::string endpoint = "tcp://127.0.0.1:5555";
    };

    CliArgs parse_args(int argc, char **argv)
    {
        CliArgs args;
        bool simulate_flag = false;
        bool live_flag = false;

        for (int i = 1; i < argc; ++i)
        {
            const std::string_view a = argv[i];
            if (a == "--simulate")
                simulate_flag = true;
            else if (a == "--live")
                live_flag = true;
            else if (!a.empty() && a.front() != '-')
                args.endpoint = std::string(a);
            else
                throw std::runtime_error("unknown argument: " + std::string(a));
        }

        if (simulate_flag && live_flag)
            throw std::runtime_error("--simulate and --live are mutually exclusive");

        args.mode = live_flag ? SourceMode::Live : SourceMode::Simulate;
        return args;
    }

    std::unique_ptr<IMarketDataSource> make_source(SourceMode mode)
    {
        switch (mode)
        {
        case SourceMode::Live:
        {
            const char *key = std::getenv("FINNHUB_API_KEY");
            if (key == nullptr || *key == '\0')
                throw std::runtime_error("--live requires FINNHUB_API_KEY to be set");
            return std::make_unique<LiveRestDataSource>(key);
        }
        case SourceMode::Simulate:
            break;
        }
        return std::make_unique<SimulatedDataSource>();
    }

    std::string_view mode_label(SourceMode mode)
    {
        return mode == SourceMode::Live ? "live" : "simulate";
    }

    std::string exe_dir(const char *argv0)
    {
        const std::string p = (argv0 != nullptr) ? argv0 : "";
        const auto slash = p.find_last_of('/');
        return (slash == std::string::npos) ? "." : p.substr(0, slash);
    }

    void load_env(const char *argv0)
    {
        // Try, in order: next to the binary's parent dir (cwd-independent for the
        // documented ./cpp_engine/build/cpp_engine layout), then the repo-root and
        // in-directory relative paths.
        const std::string loaded = dotenv::load_first({
            exe_dir(argv0) + "/../.env",
            "cpp_engine/.env",
            ".env",
        });
        if (!loaded.empty())
            std::cerr << "[cpp_engine] loaded env from " << loaded << "\n";
    }
} // namespace

int main(int argc, char **argv)
{
    try
    {
        load_env(argv[0]);

        const CliArgs args = parse_args(argc, argv);

        auto source = make_source(args.mode);

        // Built-in macro baseline. Used standalone, and as the fallback whenever
        // the agent has no user interests to push (see SharedFilter).
        SharedFilter filter{{
            "FOMC", "CPI", "PCE", "inflation",
            "Fed", "Powell", "Rates", "ECB",
            "Treasury", "yield", "jobs", "payroll",
            "unemployment", "GDP", "recession",
            "tariff", "stimulus", "central bank", "bond",
        }};

        // Reverse channel: the agent pushes the union of all users' tracked
        // keywords + watchlist tickers here, narrowing what we forward so a
        // watched ticker reaches the agent. Override with FILTER_ENDPOINT.
        const char *filterEnv = std::getenv("FILTER_ENDPOINT");
        const std::string filterEndpoint =
            (filterEnv != nullptr && *filterEnv != '\0')
                ? std::string(filterEnv)
                : "tcp://127.0.0.1:5556";
        FilterSubscriber filterSub{filterEndpoint, filter};

        ZmqPublisher publisher{args.endpoint};

        // PUB slow-joiner: give subscribers a moment to connect before the first send.
        std::this_thread::sleep_for(std::chrono::milliseconds(250));

        std::cout << "cpp_engine: publishing headlines (PUB) on " << args.endpoint
                  << " [mode=" << mode_label(args.mode) << "]\n";
        std::cout << "cpp_engine: press Ctrl+C to stop\n";

        while (true)
        {
            try
            {
                auto headline = source->nextHeadline();
                if (!headline)
                {
                    // No data available right now (queue drained / between source
                    // ticks): brief sleep so we don't busy-wait at 100% CPU.
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                    continue;
                }

                if (filter.current()->matches(*headline))
                {
                    publisher.publishHeadline(*headline);
                    std::cout << "published: " << *headline << "\n";
                }
                // Got a headline: loop again immediately to drain any backlog.
            }
            catch (const std::exception &e)
            {
                std::cerr << "[cpp_engine] loop error: " << e.what() << "\n";
                // Avoid a tight error-spin if a failure recurs every iteration.
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
        }
    }
    catch (const std::exception &e)
    {
        std::cerr << "[cpp_engine] fatal: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
