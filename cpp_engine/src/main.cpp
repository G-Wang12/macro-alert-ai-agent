#include "DotEnv.hpp"
#include "FilterSubscriber.hpp"
#include "IMarketDataSource.hpp"
#include "LiveRestDataSource.hpp"
#include "MacroFilter.hpp"
#include "PacedDataSource.hpp"
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

    const std::vector<std::string> kDefaultMacroTerms = {
        "FOMC", "CPI", "PCE", "inflation",
        "Fed", "Powell", "Rates", "ECB",
        "Treasury", "yield", "jobs", "payroll",
        "unemployment", "GDP", "recession",
        "tariff", "stimulus", "central bank", "bond",
    };

    struct CliArgs
    {
        SourceMode mode = SourceMode::Simulate;
        std::string endpoint = "tcp://127.0.0.1:5555";
        bool demo = false;
        int paceMs = 6000;
        int backlogHours = 24;
        int backlogMax = 10;
    };

    bool starts_with(std::string_view s, std::string_view prefix)
    {
        return s.size() >= prefix.size() && s.substr(0, prefix.size()) == prefix;
    }

    bool parse_int_suffix(std::string_view arg, std::string_view prefix, int &out)
    {
        if (!starts_with(arg, prefix))
            return false;
        const std::string_view value = arg.substr(prefix.size());
        if (value.empty())
            throw std::runtime_error("missing value for " + std::string(prefix));
        try
        {
            const long v = std::stol(std::string(value));
            out = static_cast<int>(v);
            return true;
        }
        catch (const std::exception &)
        {
            throw std::runtime_error("invalid integer for " + std::string(prefix) +
                                     ": " + std::string(value));
        }
    }

    int env_int_or(const char *name, int fallback)
    {
        const char *v = std::getenv(name);
        if (v == nullptr || *v == '\0')
            return fallback;
        try
        {
            return static_cast<int>(std::stol(v));
        }
        catch (const std::exception &)
        {
            return fallback;
        }
    }

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
            else if (a == "--demo")
                args.demo = true;
            else if (parse_int_suffix(a, "--pace-ms=", args.paceMs))
                continue;
            else if (parse_int_suffix(a, "--backlog-hours=", args.backlogHours))
                continue;
            else if (parse_int_suffix(a, "--backlog-max=", args.backlogMax))
                continue;
            else if (!a.empty() && a.front() != '-')
                args.endpoint = std::string(a);
            else
                throw std::runtime_error("unknown argument: " + std::string(a));
        }

        if (simulate_flag && live_flag)
            throw std::runtime_error("--simulate and --live are mutually exclusive");
        if (args.demo && !live_flag)
            throw std::runtime_error("--demo requires --live");

        if (args.paceMs < 500)
            throw std::runtime_error("--pace-ms must be at least 500");
        if (args.backlogHours < 1)
            throw std::runtime_error("--backlog-hours must be at least 1");
        if (args.backlogMax < 0)
            throw std::runtime_error("--backlog-max must be non-negative");

        args.mode = live_flag ? SourceMode::Live : SourceMode::Simulate;
        return args;
    }

    std::unique_ptr<IMarketDataSource> make_source(const CliArgs &args)
    {
        switch (args.mode)
        {
        case SourceMode::Live:
        {
            const char *key = std::getenv("FINNHUB_API_KEY");
            if (key == nullptr || *key == '\0')
                throw std::runtime_error("--live requires FINNHUB_API_KEY to be set");

            LiveRestConfig config;
            if (args.demo)
            {
                config.demo = true;
                config.backlogHours =
                    env_int_or("DEMO_BACKLOG_HOURS", args.backlogHours);
                config.backlogMax =
                    env_int_or("DEMO_BACKLOG_MAX", args.backlogMax);
                config.demoPreferTerms = kDefaultMacroTerms;
            }

            auto live = std::make_unique<LiveRestDataSource>(key, config);

            if (args.demo)
            {
                const int paceMs = env_int_or("DEMO_PACE_MS", args.paceMs);
                return std::make_unique<PacedDataSource>(
                    std::move(live), std::chrono::milliseconds(paceMs));
            }
            return live;
        }
        case SourceMode::Simulate:
            break;
        }
        return std::make_unique<SimulatedDataSource>();
    }

    std::string mode_label(const CliArgs &args)
    {
        if (args.mode == SourceMode::Simulate)
            return "simulate";
        return args.demo ? "live+demo" : "live";
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

        auto source = make_source(args);

        // Built-in macro baseline. Used standalone, and as the fallback whenever
        // the agent has no user interests to push (see SharedFilter).
        SharedFilter filter{kDefaultMacroTerms};

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
                  << " [mode=" << mode_label(args) << "]\n";
        if (args.demo)
        {
            std::cout << "cpp_engine: demo pacing "
                      << env_int_or("DEMO_PACE_MS", args.paceMs)
                      << "ms, backlog "
                      << env_int_or("DEMO_BACKLOG_HOURS", args.backlogHours)
                      << "h, max "
                      << env_int_or("DEMO_BACKLOG_MAX", args.backlogMax)
                      << " headline(s) on first fetch\n";
        }
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

                if (filter.current()->matches(headline->text))
                {
                    publisher.publishHeadline(headline->text, headline->source);
                    std::cout << "published: " << headline->text
                              << " [source: "
                              << (headline->source.empty() ? "unknown" : headline->source)
                              << "]\n";
                }
                else if (args.demo)
                {
                    std::cout << "demo: skipped (no keyword match): "
                              << headline->text << "\n";
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
