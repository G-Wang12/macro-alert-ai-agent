#pragma once

#include <optional>
#include <string>

// A single news item: the headline text plus the publisher it came from
// (e.g. "Reuters", "PRNewswire"). `source` may be empty when the upstream feed
// omits it; downstream treats an empty/unknown source as low trust.
struct Headline
{
    std::string text;
    std::string source;
};

class IMarketDataSource
{
public:
    virtual ~IMarketDataSource() = default;

    virtual std::optional<Headline> nextHeadline() = 0;
};
