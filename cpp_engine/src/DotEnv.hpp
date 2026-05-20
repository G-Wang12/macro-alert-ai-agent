#pragma once

#include <cstdlib>
#include <fstream>
#include <initializer_list>
#include <string>
#include <string_view>

namespace dotenv
{
    inline std::string trim(std::string_view s)
    {
        constexpr std::string_view ws = " \t\r\n";
        const auto begin = s.find_first_not_of(ws);
        if (begin == std::string_view::npos)
            return {};
        const auto end = s.find_last_not_of(ws);
        return std::string(s.substr(begin, end - begin + 1));
    }

    // Loads KEY=VALUE pairs from `path` into the process environment.
    // Existing environment variables are NOT overwritten (a real shell var wins
    // over the file), matching dotenv's default behavior. Returns true if the
    // file could be opened.
    inline bool load(const std::string &path)
    {
        std::ifstream file(path);
        if (!file.is_open())
            return false;

        std::string line;
        while (std::getline(file, line))
        {
            const std::string trimmed = trim(line);
            if (trimmed.empty() || trimmed.front() == '#')
                continue;

            const auto eq = trimmed.find('=');
            if (eq == std::string::npos)
                continue;

            std::string key = trim(std::string_view(trimmed).substr(0, eq));
            std::string value = trim(std::string_view(trimmed).substr(eq + 1));

            constexpr std::string_view exp = "export ";
            if (key.rfind(exp.data(), 0) == 0)
                key = trim(std::string_view(key).substr(exp.size()));
            if (key.empty())
                continue;

            if (value.size() >= 2 &&
                ((value.front() == '"' && value.back() == '"') ||
                 (value.front() == '\'' && value.back() == '\'')))
            {
                value = value.substr(1, value.size() - 2);
            }

            // overwrite=0 => leave any pre-existing env var untouched.
            ::setenv(key.c_str(), value.c_str(), 0);
        }
        return true;
    }

    // Tries each candidate path in order; loads the first that opens and returns
    // its path. Returns an empty string if none were found.
    inline std::string load_first(std::initializer_list<std::string> paths)
    {
        for (const auto &p : paths)
            if (load(p))
                return p;
        return {};
    }
} // namespace dotenv
