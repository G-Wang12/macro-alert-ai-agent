#pragma once

#include "IMarketDataSource.hpp"

#include <chrono>
#include <cstddef>
#include <optional>
#include <string>
#include <utility>
#include <vector>

class SimulatedDataSource : public IMarketDataSource
{
public:
    // Each mock headline is paired with a synthetic publisher spanning trust
    // tiers (wire services / major outlets / PR wires / no-name blogs) so the
    // source-trust labeling and filtering are exercised end-to-end without a
    // live Finnhub key.
    SimulatedDataSource()
        : headlines_{
              {"Fed raises rates by 25bps, signals higher-for-longer stance", "Reuters"},
              {"AAPL earnings beat as services revenue hits record", "Bloomberg"},
              {"US CPI comes in cooler than expected; futures rally", "Associated Press"},
              {"Oil jumps 3% on supply disruption concerns in the Middle East", "CNBC"},
              {"NVDA announces new AI chips; shares pop in after-hours", "PRNewswire"},
              {"Treasury yields fall after weak jobs report; bond market rallies", "Reuters"},
              {"ECB holds rates steady; hints at possible summer cut", "Financial Times"},
              {"TSLA deliveries miss estimates; margin pressure returns", "MarketWatch"},
              {"Gold climbs as dollar weakens and risk-off flows pick up", "Yahoo Finance"},
              {"China announces targeted stimulus; industrial metals rise", "Bloomberg"},
              {"MSFT cloud growth accelerates; upbeat guidance lifts tech", "GlobeNewswire"},
              {"Banking sector dips on renewed concerns over CRE exposure", "Seeking Alpha"},
              // Single-stock headlines (no macro keyword) for testing watchlists.
              {"GOOGL slides after antitrust ruling threatens ad business", "Reuters"},
              {"AMZN holiday sales smash records; cloud margins expand", "PRNewswire"},
              {"META unveils new AI assistant; shares rally 7% after the bell", "TechCrunch"},
              {"AMD wins major data-center deal, taking share from NVDA", "MarketBeat Blog"},
              {"JPM tops estimates as net interest income climbs to a record", "Wall Street Journal"},
              {"DIS streaming losses narrow as subscriber growth returns", "CNBC"},
              {"COIN surges as crypto trading volumes spike to yearly high", "CoinDesk"},
              {"PLTR jumps on raised guidance and new government contracts", "StockTwits"},
          }
    {
    }

    explicit SimulatedDataSource(std::vector<Headline> headlines)
        : headlines_{std::move(headlines)}
    {
    }

    std::optional<Headline> nextHeadline() override
    {
        if (headlines_.empty())
            return std::nullopt;

        // Self-pace at the 2s mock cadence: emit immediately on the first call,
        // then return nullopt between ticks. This keeps the established cadence
        // while letting the main loop treat this like any other source (which
        // sleeps briefly on nullopt) rather than pacing the loop itself.
        const auto now = std::chrono::steady_clock::now();
        if (!first_tick_ && (now - last_emit_) < kInterval)
            return std::nullopt;

        first_tick_ = false;
        last_emit_ = now;

        const Headline &h = headlines_[next_idx_];
        next_idx_ = (next_idx_ + 1) % headlines_.size();
        return h;
    }

private:
    static constexpr std::chrono::milliseconds kInterval{2000};

    std::vector<Headline> headlines_;
    std::size_t next_idx_ = 0;
    std::chrono::steady_clock::time_point last_emit_{};
    bool first_tick_ = true;
};
