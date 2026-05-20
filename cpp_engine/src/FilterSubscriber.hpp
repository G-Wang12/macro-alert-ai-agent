#pragma once

#include "SharedFilter.hpp"

#include <nlohmann/json.hpp>
#include <zmq.hpp>

#include <atomic>
#include <exception>
#include <iostream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// Subscribes to filter-set updates published by the agent and applies them to a
// SharedFilter at runtime.
//
// The agent owns user preferences (per chat, dynamic), so it computes the union
// of every user's tracked keywords + watchlist tickers and PUBs it here as
//   {"type":"filterset","terms":["CPI","FOMC","TSLA", ...]}
// The engine then narrows what it forwards to that union — which is how a
// user's watchlist ticker reaches the agent even though the engine has no other
// knowledge of users.
//
// The agent republishes on every change and on a heartbeat, so a late-joining
// or reconnecting engine converges to the current set within one interval
// (PUB/SUB does not replay missed messages).
class FilterSubscriber
{
public:
    FilterSubscriber(std::string endpoint, SharedFilter &filter)
        : endpoint_{std::move(endpoint)}, filter_{filter}, running_{true}
    {
        worker_ = std::thread([this] { run(); });
    }

    ~FilterSubscriber()
    {
        running_ = false;
        if (worker_.joinable())
            worker_.join();
    }

    FilterSubscriber(const FilterSubscriber &) = delete;
    FilterSubscriber &operator=(const FilterSubscriber &) = delete;

private:
    void run()
    {
        try
        {
            zmq::context_t ctx{1};
            zmq::socket_t sock{ctx, zmq::socket_type::sub};
            // Time out recv so the loop can observe running_ on shutdown.
            sock.set(zmq::sockopt::rcvtimeo, 200);
            sock.set(zmq::sockopt::subscribe, "");
            sock.connect(endpoint_);

            std::cout << "cpp_engine: filter subscriber connected to "
                      << endpoint_ << "\n";

            while (running_)
            {
                zmq::message_t msg;
                zmq::recv_result_t got;
                try
                {
                    got = sock.recv(msg, zmq::recv_flags::none);
                }
                catch (const zmq::error_t &)
                {
                    continue;
                }
                if (!got)
                    continue; // timed out; re-check running_

                applyMessage(msg.to_string());
            }
        }
        catch (const std::exception &e)
        {
            std::cerr << "[cpp_engine] filter subscriber error: " << e.what()
                      << "\n";
        }
    }

    void applyMessage(const std::string &payload)
    {
        nlohmann::json parsed;
        try
        {
            parsed = nlohmann::json::parse(payload);
        }
        catch (...)
        {
            return; // ignore non-JSON frames
        }

        if (!parsed.is_object())
            return;

        const auto typeIt = parsed.find("type");
        if (typeIt == parsed.end() || !typeIt->is_string() ||
            typeIt->get<std::string>() != "filterset")
            return;

        std::vector<std::string> terms;
        const auto termsIt = parsed.find("terms");
        if (termsIt != parsed.end() && termsIt->is_array())
        {
            for (const auto &term : *termsIt)
            {
                if (!term.is_string())
                    continue;
                std::string value = term.get<std::string>();
                if (!value.empty())
                    terms.push_back(std::move(value));
            }
        }

        // The agent sends on a heartbeat as well as on change, so skip swaps and
        // log noise when nothing actually changed (terms arrive pre-sorted).
        if (terms == lastTerms_)
            return;
        lastTerms_ = terms;

        const std::size_t count = terms.size();
        filter_.update(std::move(terms));
        std::cout << "cpp_engine: filter set updated from agent (" << count
                  << (count == 1 ? " term)\n" : " terms)\n");
    }

    std::string endpoint_;
    SharedFilter &filter_;
    std::atomic<bool> running_;
    std::vector<std::string> lastTerms_;
    std::thread worker_;
};
