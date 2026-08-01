(() => {
  const legacyFontPath = "/fonts/simhei.ttf";
  const vocabularyFontPath = "/vocabulary/fonts/simhei.ttf";
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    const requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(requestedUrl, window.location.href);

    if (url.origin === window.location.origin && url.pathname === legacyFontPath) {
      url.pathname = vocabularyFontPath;
      const redirectedInput = input instanceof Request ? new Request(url.href, input) : url.href;
      return nativeFetch(redirectedInput, init);
    }

    return nativeFetch(input, init);
  };
})();
