#pragma once

#include "IMarketDataSource.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <optional>
#include <queue>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>

class LiveRestDataSource : public IMarketDataSource
{
public:
    explicit LiveRestDataSource(std::string apiKey)
        : client_{"https://finnhub.io"},
          apiKey_{std::move(apiKey)},
          running_{true}
    {
        client_.set_connection_timeout(5);
        client_.set_read_timeout(5);
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
        const auto res = client_.Get(path);
        if (!res)
        {
            std::cerr << "[LiveRestDataSource] request failed: "
                      << httplib::to_string(res.error()) << "\n";
            return;
        }
        if (res->status != 200)
        {
            std::cerr << "[LiveRestDataSource] HTTP " << res->status << "\n";
            return;
        }
        ingest(res->body);
    }

    void ingest(const std::string &body)
    {
        const auto root = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (root.is_discarded() || !root.is_array())
            return;

        for (const auto &item : root)
        {
            if (!item.is_object())
                continue;

            const auto idIt = item.find("id");
            const auto headlineIt = item.find("headline");
            if (idIt == item.end() || !idIt->is_number_integer())
                continue;
            if (headlineIt == item.end() || !headlineIt->is_string())
                continue;

            // seenIds_ is only touched by this worker thread, so it needs no lock.
            const int id = idIt->get<int>();
            if (!seenIds_.insert(id).second)
                continue;

            // Finnhub returns the publisher in "source"; keep it for trust
            // scoring downstream. Leave empty when absent (treated as unknown).
            std::string source;
            const auto sourceIt = item.find("source");
            if (sourceIt != item.end() && sourceIt->is_string())
                source = sourceIt->get<std::string>();

            std::lock_guard<std::mutex> lock(mutex_);
            headlines_.push(Headline{headlineIt->get<std::string>(), std::move(source)});
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
    std::atomic<bool> running_;
    std::mutex mutex_;
    std::queue<Headline> headlines_;
    std::unordered_set<int> seenIds_;
    std::thread worker_;
};
