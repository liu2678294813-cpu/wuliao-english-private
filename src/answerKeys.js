// Reading Comprehension Part A reference keys for postgraduate English I.
// 2007-2008: CHSI; 2009: Wendu; 2010-2023: Beiding compilation.
const YEAR_KEYS = {
  2007: "CBADCDCAABCBDCBDABAD",
  2008: "ADCBDDCAABACBDCDDCAB",
  2009: "ABCAAACDABDBBACBBDAC",
  2010: "BADABCDC BABDACCADCBD".replaceAll(" ", ""),
  2011: "CBDBABDCACDCBAACDADB",
  2012: "DBACDCDADAABBDCCDBCA",
  2013: "BDADCBDCADBADCCCCDAB",
  2014: "BCDADDCBACDBBAAAC CDB".replaceAll(" ", ""),
  2015: "DCADDBCADB BCDC AABCAC".replaceAll(" ", ""),
  2016: "BDACADADBDBACABADBCC",
  2017: "BCDDCBABADDBD CADCABD".replaceAll(" ", ""),
  2018: "DCADB DABCABCDDBBAACD".replaceAll(" ", ""),
  2019: "ADBCBDAACBCDBACCDCBA",
  2020: "CBDBCDACADACDCBCABCB",
  2021: "CBC DDBDCCAABDAACBBDA".replaceAll(" ", ""),
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
