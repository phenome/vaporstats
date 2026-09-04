import React from "react";

export interface SearchFormProps {
  initialQuery?: string;
  className?: string;
  placeholder?: string;
  size?: "default" | "large";
}

export function SearchForm({
  initialQuery = "",
  className = "",
  placeholder = "Search games or AppID...",
  size = "default",
}: SearchFormProps) {
  const isLarge = size === "large";
  const inputId = React.useId();

  return (
    <form
      action="/search"
      method="GET"
      role="search"
      aria-label="Steam catalog search"
      className={`relative flex items-center min-w-0 w-full ${className}`}
    >
      <label htmlFor={inputId} className="sr-only">
        Search games or AppID
      </label>
      <input
        id={inputId}
        type="text"
        name="q"
        defaultValue={initialQuery}
        placeholder={placeholder}
        aria-label="Search games or AppID"
        autoComplete="off"
        className={`bg-zinc-900 border border-zinc-800 font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 rounded-none transition-colors min-w-0 min-h-[44px] ${
          isLarge
            ? "w-full px-4 py-3 text-sm sm:text-base"
            : "w-28 sm:w-64 flex-1 px-2.5 sm:px-3 py-1.5 text-xs"
        }`}
      />
      <button
        type="submit"
        aria-label="Submit search query"
        className={`bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white font-mono border-l-0 border border-zinc-800 rounded-none transition-colors cursor-pointer shrink-0 min-h-[44px] min-w-[44px] inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
          isLarge ? "px-6 py-3 text-sm sm:text-base font-bold" : "px-2.5 sm:px-3 py-1.5 text-xs"
        }`}
      >
        Search
      </button>
    </form>
  );
}

export default SearchForm;
