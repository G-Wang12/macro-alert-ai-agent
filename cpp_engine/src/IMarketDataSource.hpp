#pragma once

#include <optional>
#include <string>

class IMarketDataSource
{
public:
    virtual ~IMarketDataSource() = default;

    virtual std::optional<std::string> nextHeadline() = 0;
};
