// Reading Comprehension Part A reference keys for postgraduate English I.
// Verified against the supplied solution volumes (2007-2016 and 2017-2026).
// The app's official reading resources currently cover 2007-2023.
const YEAR_KEYS = {
  2007: "CBADCDCAABCBDCBDABAD",
  2008: "ADCBDDCAABACBDCDBCAB",
  2009: "CDADAACDABDBBCCBBDCC",
  2010: "BADABCDC BABDACCADCBD".replaceAll(" ", ""),
  2011: "CBDBABDCACDCBAACDADB",
  2012: "DBACDCDADAABBDCCDBCA",
  2013: "DBACCADCBDBBDACACBAD",
  2014: "CADBADBCDCCBADBADCBA",
  2015: "DABDCBCADBBCDCAADCAB",
  2016: "ADBCADACBCBCDBADABCD",
  2017: "BCBDAACDABDADBCCACCD",
  2018: "DCADBDCBABCDBACBAACD",
  2019: "BDCACBDACDABCDACDBAB",
  2020: "CBDBCDACADACDCBBDABA",
  2021: "DBCAACADDBBCABCADDBC",
  2022: "ACDDBCB CDABAABCDADBC".replaceAll(" ", ""),
  2023: "CBACDADBCDACBADBCABD",
};

export function getOfficialAnswerKey(resource) {
  const keys = YEAR_KEYS[Number(resource.year)];
  const text = Number(resource.text);
  if (!keys || !Number.isInteger(text) || text < 1 || text > 4) return {};
  const start = (text - 1) * 5;
  return Object.fromEntries(
    keys.slice(start, start + 5).split("").map((answer, index) => [20 + start + index + 1, answer]),
  );
}
