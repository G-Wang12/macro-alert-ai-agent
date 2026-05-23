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
              // --- FOMC / Fed / Powell ---
              {"Powell: Fed is prepared to keep rates elevated until inflation is clearly cooling", "Reuters"},
              {"FOMC minutes show split on timing of first rate cut; markets whipsaw", "Bloomberg"},
              {"Fed's Waller says two rate cuts this year still plausible if data cooperate", "Wall Street Journal"},
              {"Fed holds policy rate unchanged; dot plot shifts hawkish for 2025", "Associated Press"},
              {"Powell presser: labor market rebalancing, not weakening, supports patience on cuts", "CNBC"},
              {"Fed's Bowman warns premature easing could re-ignite inflation expectations", "Federal Reserve"},
              {"FOMC statement removes 'balanced risks' language; dollar firms", "Financial Times"},
              {"Fed balance sheet runoff pace unchanged; QT debate intensifies on Capitol Hill", "Reuters"},
              {"Powell cites sticky services inflation as key hurdle to policy pivot", "MarketWatch"},
              {"Fed emergency lending facility usage ticks up; regional bank stress in focus", "Bloomberg"},
              // --- CPI / PCE / inflation ---
              {"Core CPI accelerates to 0.4% m/m; supercore remains elevated", "Bureau of Labor Statistics"},
              {"Headline CPI unchanged; shelter disinflation finally shows in the data", "Reuters"},
              {"PCE price index matches expectations; Fed's preferred gauge still above target", "Associated Press"},
              {"Inflation expectations in UMich survey jump; bond vigilantes on alert", "Bloomberg"},
              {"CPI report: used car prices rebound; goods deflation narrative challenged", "CNBC"},
              {"PCE core services ex-housing sticky at 0.3%; traders push out cut bets", "Financial Times"},
              {"Inflation swaps price in higher terminal rate after hot CPI surprise", "MarketWatch"},
              {"CPI y/y falls to 2.9%; markets debate whether this is the start of a trend", "Reuters"},
              {"Wholesale inflation (PPI) hotter than forecast; pipeline pressure for CPI", "Associated Press"},
              {"Inflation breakevens widen as oil rally feeds through to energy CPI", "Bloomberg"},
              // --- Jobs / payroll / unemployment ---
              {"Nonfarm payrolls smash estimates at +275k; unemployment rate holds at 3.8%", "Bureau of Labor Statistics"},
              {"Jobs report: average hourly earnings rise 0.4%; wage inflation in focus", "Reuters"},
              {"Unemployment claims fall to six-month low; labor market resilience persists", "Department of Labor"},
              {"Payrolls miss badly at +12k; hurricane distortions muddy the read", "Associated Press"},
              {"Unemployment rate ticks up to 4.2%; Sahm rule chatter returns", "Bloomberg"},
              {"JOLTS job openings plunge; quit rate normalizes as hiring slows", "CNBC"},
              {"ADP private payrolls disappoint; bond rally on soft-landing hopes", "ADP Research"},
              {"Jobs data revision wipes 818k from prior estimates; Fed credibility in spotlight", "Reuters"},
              {"Unemployment benefits extended in three states; political pressure on Fed grows", "Politico"},
              {"Payrolls in focus ahead of FOMC; traders price 40% chance of September cut", "MarketWatch"},
              // --- GDP / recession ---
              {"US GDP growth revised up to 3.1% annualized; consumer spending drives beat", "Bureau of Economic Analysis"},
              {"GDPNow tracker points to sub-1% Q4; recession odds climb in prediction markets", "Atlanta Fed"},
              {"Recession fears ease as ISM manufacturing returns to expansion", "Reuters"},
              {"GDP contraction in Germany raises eurozone recession risk", "Bloomberg"},
              {"Yield curve uninverts; historians note recession signal often lags the turn", "Financial Times"},
              {"Soft landing base case strengthens as GDP and inflation both cool", "Goldman Sachs Research"},
              {"Recession watch: leading indicators fall for 19th straight month", "The Conference Board"},
              {"UK GDP flatlines; BoE cut expectations firm", "BBC News"},
              {"Japan GDP beats; weak yen boosts exporters", "Nikkei"},
              {"Global recession probability falls to 25% in IMF outlook", "International Monetary Fund"},
              // --- ECB / central bank (global) ---
              {"ECB cuts deposit rate by 25bps; Lagarde flags data-dependent path", "European Central Bank"},
              {"BoE holds Bank Rate at 5.25%; Bailey cites services inflation stickiness", "Bank of England"},
              {"BoJ ends negative rates; yen spikes on policy normalization", "Reuters"},
              {"SNB surprises with rate cut; franc weakens", "Swiss National Bank"},
              {"RBA keeps rates on hold; Lowe successor signals patience", "Reserve Bank of Australia"},
              {"PBoC cuts reserve requirement ratio; liquidity injection supports property sector", "Xinhua"},
              {"Central bank gold buying hits record; dedollarization theme gains traction", "World Gold Council"},
              {"ECB's Schnabel pushes back on rapid easing; euro strengthens", "Financial Times"},
              {"Bank of Canada cuts for third meeting; Macklem cites excess supply", "Bank of Canada"},
              {"Norges Bank holds; oil wealth fund flows dominate krone", "Reuters"},
              // --- Treasury / yield / bond ---
              {"10-year Treasury yield breaks above 4.5%; mortgage rates follow higher", "Reuters"},
              {"Treasury auction: 30-year bonds tail; foreign demand soft", "Bloomberg"},
              {"Bond market rally as weak payrolls boost cut bets", "Associated Press"},
              {"Yield curve steepens sharply after CPI; 2s10s spread widest since 2022", "CNBC"},
              {"Treasury Secretary Yellen: US fiscal path sustainable; markets skeptical", "Treasury Department"},
              {"High-yield bond spreads widen on recession fears; CCCs under pressure", "Moody's"},
              {"TIPS breakevens rise; real yields fall on growth scare", "MarketWatch"},
              {"Treasury buyback program expanded; liquidity support for long end", "Reuters"},
              {"Municipal bond market sees record outflows; tax-loss selling cited", "Bond Buyer"},
              {"Corporate bond issuance surges ahead of blackout; IG supply heavy", "Bloomberg"},
              // --- Tariff / trade / fiscal / stimulus ---
              {"White House announces 25% tariff on steel and aluminum imports", "Reuters"},
              {"Tariff escalation on China EVs; retaliatory measures expected", "Associated Press"},
              {"EU threatens counter-tariffs on US tech goods; trade war rhetoric heats up", "Financial Times"},
              {"Congress passes $200B infrastructure stimulus package", "Politico"},
              {"Fiscal deficit widens to $1.8T; bond vigilantes demand term premium", "Congressional Budget Office"},
              {"China unveils property-sector stimulus; developers rally", "Bloomberg"},
              {"Japan fiscal stimulus package targets household energy rebates", "Nikkei"},
              {"Tariff revenue estimates revised up; offset to tax cut extensions", "Wall Street Journal"},
              {"Stimulus checks debated in election year; consumer stocks volatile", "CNBC"},
              {"US-Mexico trade flows hit record despite tariff threats on autos", "Reuters"},
              // --- Rates / cross-asset macro ---
              {"Rates volatility spikes as CPI and payrolls collide in same week", "Bloomberg"},
              {"SOFR futures imply three cuts by year-end; front-end rallies", "CME Group"},
              {"Mortgage rates hit 7.5% on backup in Treasury yields", "Mortgage News Daily"},
              {"Fed funds futures fully price December cut after weak data", "Reuters"},
              {"Rates strategists turn bullish on duration after payrolls miss", "Barclays Research"},
              {"EM central banks cut rates in sync with Fed pause; carry trades revive", "JPMorgan"},
              {"Swap spreads widen on bank funding stress; Libor-OIS analog in focus", "Financial Times"},
              {"Interest rate caps on student loans extended; fiscal cost debated", "Department of Education"},
              {"Rates desk: long-end rally overdone if inflation re-accelerates", "Goldman Sachs"},
              {"Negative rates return in Europe money markets on ECB path", "Bloomberg"},
              // --- Geopolitical / energy macro (keyword-rich) ---
              {"Oil surge lifts inflation breakevens; Fed may delay cuts", "Reuters"},
              {"Middle East escalation sends yields lower on flight to quality", "Associated Press"},
              {"Dollar index hits multi-month high; EM bonds under pressure", "Bloomberg"},
              {"Risk-off: equities fall, bonds rally on recession headline", "CNBC"},
              {"Credit spreads blow out; Fed liquidity backstop in focus", "Financial Times"},
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
