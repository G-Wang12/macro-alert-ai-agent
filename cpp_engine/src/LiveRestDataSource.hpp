#pragma once

#include "IMarketDataSource.hpp"
#include "MacroFilter.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <iostream>
#include <mutex>
#include <optional>
#include <queue>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

struct LiveRestConfig
{
    // Demo mode: on the first Finnhub snapshot, enqueue a capped backlog instead
    // of every unseen item. Prefer headlines matching demoPreferTerms (macro
    // keywords) from the full snapshot; fall back to recent general news only if
    // none match. All snapshot IDs are marked seen so later polls add only new
    // articles.
    bool demo = false;
    int backlogHours = 24;
    int backlogMax = 10;
    std::vector<std::string> demoPreferTerms;
};

class LiveRestDataSource : public IMarketDataSource
{
public:
    explicit LiveRestDataSource(std::string apiKey,
                                LiveRestConfig config = {})
        : client_{"https://finnhub.io"},
          apiKey_{std::move(apiKey)},
          config_{config},
          running_{true}
    {
        client_.set_connection_timeout(10);
        client_.set_read_timeout(30);
        // Finnhub closes idle keep-alive sockets; reusing the connection on the
        // 2s poll loop caused intermittent "Failed to read connection" errors.
        client_.set_keep_alive(false);
        worker_ = std::thread([this] { run(); });
    }

    ~LiveRestDataSource() override
    {
        running_.store(false);
        if (worker_.joinable())
            worker_.join();
    }

    LiveRestDataSource(const LiveRestDataSource &) = delete;
    LiveRestDataSource &operator=(const LiveRestDataSource &) = delete;

    std::optional<Headline> nextHeadline() override
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (headlines_.empty())
            return std::nullopt;

        Headline headline = std::move(headlines_.front());
        headlines_.pop();
        return headline;
    }

private:
    struct ParsedItem
    {
        int id = 0;
        Headline headline;
        std::int64_t datetime = 0; // Unix seconds; 0 when absent
    };

    void run()
    {
        while (running_.load())
        {
            poll();
            interruptibleSleep(std::chrono::seconds(2));
        }
    }

    void poll()
    {
        const std::string path = "/api/v1/news?category=general&token=" + apiKey_;
        constexpr int kMaxAttempts = 3;
        for (int attempt = 1; attempt <= kMaxAttempts; ++attempt)
        {
            const auto res = client_.Get(path);
            if (!res)
            {
                std::cerr << "[LiveRestDataSource] request failed (attempt "
                          << attempt << "/" << kMaxAttempts << "): "
                          << httplib::to_string(res.error()) << "\n";
                if (attempt < kMaxAttempts)
                    interruptibleSleep(std::chrono::milliseconds(500));
                continue;
            }
            if (res->status != 200)
            {
                std::cerr << "[LiveRestDataSource] HTTP " << res->status
                          << " (attempt " << attempt << "/" << kMaxAttempts
                          << ")\n";
                if (attempt < kMaxAttempts)
                    interruptibleSleep(std::chrono::milliseconds(500));
                continue;
            }
            ingest(res->body);
            return;
        }
    }

    static std::optional<ParsedItem> parseItem(const nlohmann::json &item)
    {
        if (!item.is_object())
            return std::nullopt;

        const auto idIt = item.find("id");
        const auto headlineIt = item.find("headline");
        if (idIt == item.end() || !idIt->is_number_integer())
            return std::nullopt;
        if (headlineIt == item.end() || !headlineIt->is_string())
            return std::nullopt;

        std::string source;
        const auto sourceIt = item.find("source");
        if (sourceIt != item.end() && sourceIt->is_string())
            source = sourceIt->get<std::string>();

        std::int64_t datetime = 0;
        const auto dtIt = item.find("datetime");
        if (dtIt != item.end())
        {
            if (dtIt->is_number_integer())
                datetime = dtIt->get<std::int64_t>();
            else if (dtIt->is_number_unsigned())
                datetime = static_cast<std::int64_t>(dtIt->get<std::uint64_t>());
        }

        return ParsedItem{
            idIt->get<int>(),
            Headline{headlineIt->get<std::string>(), std::move(source)},
            datetime,
        };
    }

    void seedDemoBacklog(const nlohmann::json &root)
    {
        const std::int64_t now =
            static_cast<std::int64_t>(std::chrono::system_clock::to_time_t(
                std::chrono::system_clock::now()));
        const std::int64_t cutoff =
            now - static_cast<std::int64_t>(config_.backlogHours) * 3600;

        const MacroFilter prefer{config_.demoPreferTerms};
        std::vector<ParsedItem> macroMatches;
        std::vector<ParsedItem> recentGeneral;
        macroMatches.reserve(root.size());
        recentGeneral.reserve(root.size());

        for (const auto &item : root)
        {
            const auto parsed = parseItem(item);
            if (!parsed)
                continue;

            // Mark every ID in the first snapshot as seen so we do not re-queue
            // the full feed on the next 2s poll.
            seenIds_.insert(parsed->id);

            const bool recent =
                parsed->datetime <= 0 || parsed->datetime >= cutoff;
            const bool matches = prefer.matches(parsed->headline.text);

            if (matches)
                macroMatches.push_back(*parsed);
            else if (recent)
                recentGeneral.push_back(*parsed);
        }

        const auto byNewest = [](const ParsedItem &a, const ParsedItem &b) {
            return a.datetime > b.datetime;
        };
        std::sort(macroMatches.begin(), macroMatches.end(), byNewest);
        std::sort(recentGeneral.begin(), recentGeneral.end(), byNewest);

        const std::size_t cap = static_cast<std::size_t>(
            std::max(0, config_.backlogMax));
        std::vector<ParsedItem> selected;
        selected.reserve(cap);

        for (const auto &item : macroMatches)
        {
            if (selected.size() >= cap)
                break;
            selected.push_back(item);
        }

        bool usedFallback = false;
        if (selected.empty() && cap > 0)
        {
            usedFallback = true;
            for (const auto &item : recentGeneral)
            {
                if (selected.size() >= cap)
                    break;
                selected.push_back(item);
            }
        }

        {
            std::lock_guard<std::mutex> lock(mutex_);
            for (auto &c : selected)
                headlines_.push(std::move(c.headline));
        }

        std::size_t macroQueued = 0;
        for (const auto &item : selected)
        {
            if (prefer.matches(item.headline.text))
                ++macroQueued;
        }

        demoBacklogSeeded_ = true;
        std::cerr << "[LiveRestDataSource] demo backlog: queued "
                  << selected.size() << " headline(s) ("
                  << macroQueued << " will pass macro filter; "
                  << macroMatches.size() << " macro match(es) in full snapshot; window "
                  << config_.backlogHours << "h, max " << config_.backlogMax
                  << ")";
        if (usedFallback)
            std::cerr << " — no macro matches; using recent general news";
        std::cerr << "\n";
    }

    void ingest(const std::string &body)
    {
        const auto root = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (root.is_discarded() || !root.is_array())
            return;

        if (config_.demo && !demoBacklogSeeded_)
        {
            seedDemoBacklog(root);
            return;
        }

        for (const auto &item : root)
        {
            const auto parsed = parseItem(item);
            if (!parsed)
                continue;

            // seenIds_ is only touched by this worker thread, so it needs no lock.
            if (!seenIds_.insert(parsed->id).second)
                continue;

            std::lock_guard<std::mutex> lock(mutex_);
            headlines_.push(std::move(parsed->headline));
        }
    }

    void interruptibleSleep(std::chrono::milliseconds total)
    {
        constexpr auto step = std::chrono::milliseconds(100);
        while (total.count() > 0 && running_.load())
        {
            const auto chunk = std::min(step, total);
            std::this_thread::sleep_for(chunk);
            total -= chunk;
        }
    }

    httplib::Client client_;
    std::string apiKey_;
    LiveRestConfig config_;
    std::atomic<bool> running_;
    std::mutex mutex_;
    std::queue<Headline> headlines_;
    std::unordered_set<int> seenIds_;
    bool demoBacklogSeeded_ = false;
    std::thread worker_;
};
