/* Kelly Page: shows #kp-missing (top of body) if Kelly's scripts did not load, even when the CSS did.
 * Its own file, not inline, so the hosted copy can run under a script-src 'self' CSP. Loaded last in index.html. */
(function () {
  if (/\.zip|[\\\/]Temp\d*_/i.test(decodeURIComponent(location.href)))
    document.getElementById("kp-missing-why").textContent =
      "It looks like index.html was opened straight from inside the zip -- Windows only unpacks that one file, so the rest of Kelly is missing.";
  if (typeof CCDI === "undefined" || typeof KellyLicense === "undefined")
    document.getElementById("kp-missing").style.setProperty("display", "block", "important");
})();
