#pragma once

#include "IMarketDataSource.hpp"

#include <chrono>
#include <cstddef>
#include <optional>
#include <string>
#include <vector>

class SimulatedDataSource : public IMarketDataSource
{
public:
    SimulatedDataSource()
        : headlines_{
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
          }
    {
    }

    explicit SimulatedDataSource(std::vector<std::string> headlines)
        : headlines_{std::move(headlines)}
    {
    }

    std::optional<std::string> nextHeadline() override
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

        const std::string &h = headlines_[next_idx_];
        next_idx_ = (next_idx_ + 1) % headlines_.size();
        return h;
    }

private:
    static constexpr std::chrono::milliseconds kInterval{2000};

    std::vector<std::string> headlines_;
    std::size_t next_idx_ = 0;
    std::chrono::steady_clock::time_point last_emit_{};
    bool first_tick_ = true;
};
