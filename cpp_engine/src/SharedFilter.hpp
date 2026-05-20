#pragma once

#include "MacroFilter.hpp"

#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

// Thread-safe holder for the currently active MacroFilter.
//
// The main publish loop reads the active filter once per headline; a background
// thread (FilterSubscriber) swaps in a new term set whenever the agent pushes
// an updated set of interests (tracked keywords + watchlist tickers).
//
// An empty pushed set falls back to the built-in macro defaults, so the engine
// still forwards the macro baseline when no user has expressed any specific
// interest (and standalone runs without an agent keep their original behavior).
class SharedFilter
{
public:
    explicit SharedFilter(std::vector<std::string> defaults)
        : defaults_{std::move(defaults)},
          active_{std::make_shared<const MacroFilter>(defaults_)}
    {
    }

    // Snapshot the active filter. Cheap, lock-held only long enough to copy the
    // shared_ptr; matching then happens without holding the lock.
    std::shared_ptr<const MacroFilter> current() const
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return active_;
    }

    // Replace the active term set. An empty set restores the defaults.
    void update(std::vector<std::string> terms)
    {
        auto next = terms.empty()
                        ? std::make_shared<const MacroFilter>(defaults_)
                        : std::make_shared<const MacroFilter>(std::move(terms));
        std::lock_guard<std::mutex> lock(mutex_);
        active_ = std::move(next);
    }

private:
    std::vector<std::string> defaults_;
    mutable std::mutex mutex_;
    std::shared_ptr<const MacroFilter> active_;
};
