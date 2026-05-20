#pragma once

#include <algorithm>
#include <ranges>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

class MacroFilter
{
public:
    explicit MacroFilter(std::vector<std::string> keywords)
        : keywords_{std::move(keywords)}
    {
    }

    bool matches(std::string_view headline) const
    {
        return std::ranges::any_of(keywords_, [headline](const std::string &kw) {
            if (kw.empty())
                return true;

            const auto found = std::ranges::search(
                headline,
                kw,
                [](unsigned char a, unsigned char b) {
                    return ascii_tolower(a) == ascii_tolower(b);
                });
            return !found.empty();
        });
    }

private:
    static constexpr unsigned char ascii_tolower(unsigned char c) noexcept
    {
        return (c >= 'A' && c <= 'Z') ? static_cast<unsigned char>(c + ('a' - 'A')) : c;
    }

    std::vector<std::string> keywords_;
};
