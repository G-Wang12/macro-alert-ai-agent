#pragma once

#include "IMarketDataSource.hpp"

#include <chrono>
#include <memory>
#include <optional>
#include <utility>

// Rate-limits emissions from an inner source so demos get a steady trickle
// instead of draining a live API backlog in one burst.
class PacedDataSource : public IMarketDataSource
{
public:
    PacedDataSource(std::unique_ptr<IMarketDataSource> inner,
                    std::chrono::milliseconds interval)
        : inner_{std::move(inner)},
          interval_{interval}
    {
    }

    std::optional<Headline> nextHeadline() override
    {
        const auto now = std::chrono::steady_clock::now();

        if (pending_)
        {
            if (!first_emit_ && (now - last_emit_) < interval_)
                return std::nullopt;

            last_emit_ = now;
            first_emit_ = false;
            Headline out = std::move(*pending_);
            pending_.reset();
            return out;
        }

        auto headline = inner_->nextHeadline();
        if (!headline)
            return std::nullopt;

        if (first_emit_)
        {
            first_emit_ = false;
            last_emit_ = now;
            return headline;
        }

        if ((now - last_emit_) < interval_)
        {
            pending_ = std::move(headline);
            return std::nullopt;
        }

        last_emit_ = now;
        return headline;
    }

private:
    std::unique_ptr<IMarketDataSource> inner_;
    std::chrono::milliseconds interval_;
    std::chrono::steady_clock::time_point last_emit_{};
    bool first_emit_ = true;
    std::optional<Headline> pending_;
};
