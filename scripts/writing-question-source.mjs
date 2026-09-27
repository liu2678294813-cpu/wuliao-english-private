// Audited transcription definitions for Slice 9.5. Development-time only.
// Every string below was checked against the rendered source page.
const pdf = (year) => `${year}年真题及答案速查.pdf`;

const sourceMeta = {
  2001: [16, 16, "6a7ce48de4db5100520a73ea99633654debc49dde01cff310331e6c464d44892", [0.22, 0.42, 0.66, 0.31]],
  2002: [14, 14, "daadfa9ba2fc439b7b8d0314b76f1f279cbd97c53716ec1324ba01ba631854cb", [0.25, 0.32, 0.50, 0.37]],
  2003: [15, 15, "7f91d59c3e0985748472ec0c38a0c53b016df13c20e74ab7b4c8d161d27666b5", [0.22, 0.30, 0.56, 0.40]],
  2004: [14, 15, "36010d0225fabc9c0fa43c2a2c623d39440faef05ddf993e58e87c7dcab1f901", [0.27, 0.32, 0.46, 0.31]],
  2005: [15, 16, "d5f1078e6349f7a704118e835967fca1419559737cf4c3ae138ac5f6560305ad", [0.20, 0.58, 0.60, 0.34]],
  2006: [15, 16, "fa6ca5315c526d0c15ad35afb504b7dbc30a0ba8150be4d8fde23529886dc1dd", [0.20, 0.58, 0.60, 0.28]],
  2007: [15, 16, "3fad387e58419f379bed9f6d501c213c3f05cef762b1d1777e3e1dda346414a1", [0.24, 0.50, 0.56, 0.42]],
  2008: [15, 16, "bb1690e939c18790fee13883337f24e34df793ae4b9e5579ae0f4b4a2a242cf9", [0.25, 0.60, 0.50, 0.29]],
  2009: [15, 16, "6a4003eb037362e5fff38612ff5b258459479ae32b1a666b881a6e0f2025eef0", [0.23, 0.60, 0.54, 0.30]],
  2010: [15, 16, "e69a149ff7cb2d6303521dfcf68a6d5bedef5cc6056df9b92836ea2352a19bc1", [0.29, 0.60, 0.42, 0.29]],
  2011: [15, 16, "020f91d3db7ba5b489674b2615b56e58daa1f42762a4267a7369a67e8580af70", [0.23, 0.61, 0.54, 0.30]],
  2012: [15, 16, "8ba9d02a72a143b538a52487065b05d82cfabd13e170f9f6d432fa96272a52e8", [0.27, 0.65, 0.46, 0.27]],
  2013: [15, 16, "35528e5ac06998f252296b29bffbfd1dc6575f1c8e494f2fd1f5b460a9bef501", [0.21, 0.67, 0.58, 0.26]],
  2014: [15, 16, "3d576ac3c9128eb7952cea9ec128f61447b15c04fecdb36c766ebe99b23bddab", [0.22, 0.65, 0.56, 0.27]],
  2015: [15, 16, "a93cd343694ab930e49c0eadb28e685c1b2efc7f1c6f57b50826ba23c2876dce", [0.23, 0.66, 0.54, 0.26]],
  2016: [15, 16, "f8d18488cba195df79abcb7cd4e4aab89486746fe641d9c0e6d74f24cc6261ee", [0.15, 0.68, 0.70, 0.23]],
  2017: [15, 16, "1cb61f5f3c978d7541d322efbc7294aefa8a7a3863452e3867b48077469ea78f", [0.15, 0.67, 0.70, 0.23]],
  2018: [15, 16, "30c5770f98ad41069a359692b1b9cb6bedb814f01ce60aaaec7c2629e055e27f", [0.24, 0.59, 0.52, 0.32]],
  2019: [15, 16, "8f1589a4e2423615c04ef967866c5a87604024546be56bdafa5791abb28ecf61", [0.20, 0.59, 0.60, 0.33]],
  2020: [15, 16, "c555a320e417b3276c8e561463ef24ec8698bf52de58629462c9a13b3f87b31b", [0.18, 0.63, 0.64, 0.28]],
  2021: [15, 16, "219b5815423f67b91f4ca743c52a271d13ce12f32b9198e3ca828e95f14887c9", [0.23, 0.57, 0.54, 0.34]],
  2022: [15, 16, "2376a5402f0ebb41310edfe23ed1a89237b93c48f2125987bd3aa1b41fd538ea", [0.18, 0.57, 0.64, 0.33]],
  2023: [15, 16, "cea9ac7ffb2e6681c96aebb77f59404b4080989ab5d8a3cfa83b33d164c46a84", [0.18, 0.615, 0.64, 0.29]],
};

const A = (promptText, directions, promptKind, requiredContentPoints = []) => ({ promptText, directions, promptKind, requiredContentPoints });
const B = (promptText, directions, requiredContentPoints) => ({ promptText, directions, promptKind: "picture", requiredContentPoints });

const tasks = {
  2001: { b: B("Among all the worthy feelings of mankind, love is probably the noblest, but everyone has his/her own understanding of it.\n\nThere has been a discussion recently on the issue in a newspaper. Write an essay to the newspaper to\n\n1) show your understanding of the symbolic meaning of the picture below,\n2) give a specific example, and\n3) give your suggestion as to the best way to show love.", "You should write about 200 words neatly on ANSWER SHEET 2. (20 points)", ["show your understanding of the symbolic meaning of the picture below", "give a specific example", "give your suggestion as to the best way to show love"]) },
  2002: { b: B("Study the following picture carefully and write an essay entitled “Cultures—National and International”.\n\nIn the essay you should\n\n1) describe the picture and interpret its meaning, and\n2) give your comment on the phenomenon.", "You should write about 200 words neatly on ANSWER SHEET 2. (20 points)", ["describe the picture and interpret its meaning", "give your comment on the phenomenon"]) },
  2003: { b: B("Study the following set of drawings carefully and write an essay in which you should\n\n1) describe the set of drawings, interpret its meaning, and\n2) point out its implications in our life.", "You should write about 200 words neatly on ANSWER SHEET 2. (20 points)", ["describe the set of drawings, interpret its meaning", "point out its implications in our life"]) },
  2004: { b: B("Study the following drawing carefully and write an essay in which you should\n\n1) describe the drawing,\n2) interpret its meaning, and\n3) support your view with examples.", "You should write about 200 words neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing", "interpret its meaning", "support your view with examples"]) },
  2005: {
    a: A("Two months ago you got a job as an editor for the magazine Designs & Fashions. But now you find that the work is not what you expected. You decide to quit. Write a letter to your boss, Mr. Wang, telling him your decision, stating your reason(s), and making an apology.", "Write your letter with no less than 100 words. Write it neatly on ANSWER SHEET 2. Do not sign your own name at the end of the letter; use “Li Ming” instead. You do not need to write the address. (10 points)", "letter", ["telling him your decision", "stating your reason(s)", "making an apology"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should first describe the drawing, then interpret its meaning, and give your comment on it.", "You should write neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing", "interpret its meaning", "give your comment on it"]),
  },
  2006: {
    a: A("You want to contribute to Project Hope by offering financial aid to a child in a remote area. Write a letter to the department concerned, asking them to help find a candidate. You should specify what kind of child you want to help and how you will carry out your plan.", "Write your letter in no less than 100 words. Write it neatly on ANSWER SHEET 2. Do not sign your own name at the end of the letter; use “Li Ming” instead. Do not write the address. (10 points)", "letter", ["specify what kind of child you want to help", "specify how you will carry out your plan"]),
    b: B("Study the following photos carefully and write an essay in which you should\n\n1) describe the photos briefly,\n2) interpret the social phenomenon reflected by them, and\n3) give your point of view.", "You should write 160–200 words neatly on ANSWER SHEET 2. (20 points)", ["describe the photos briefly", "interpret the social phenomenon reflected by them", "give your point of view"]),
  },
  2007: {
    a: A("Write a letter to your university library, making suggestions for improving its service.", "You should write about 100 words on ANSWER SHEET 2. Do not sign your own name at the end of the letter. Use “Li Ming” instead. Do not write the address. (10 points)", "letter", ["make suggestions for improving its service"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should\n\n1) describe the drawing briefly,\n2) explain its intended meaning, and then\n3) support your view with an example/examples.", "You should write neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing briefly", "explain its intended meaning", "support your view with an example/examples"]),
  },
  2008: {
    a: A("You have just come back from Canada and found a music CD in your luggage that you forgot to return to Bob, your landlord there. Write him a letter to\n\n1) make an apology, and\n2) suggest a solution.", "You should write about 100 words on ANSWER SHEET 2. Do not sign your own name at the end of the letter. Use “Li Ming” instead. Do not write the address. (10 points)", "letter", ["make an apology", "suggest a solution"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should\n\n1) describe the drawing briefly,\n2) explain its intended meaning, and then\n3) give your comments.", "You should write neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing briefly", "explain its intended meaning", "give your comments"]),
  },
  2009: {
    a: A("Restrictions on the use of plastic bags have not been so successful in some regions. “White Pollution” is still going on.\n\nWrite a letter to the editor(s) of your local newspaper to\n\n1) give your opinions briefly, and\n2) make two or three suggestions.", "You should write about 100 words on ANSWER SHEET 2. Do not sign your own name at the end of the letter. Use “Li Ming” instead. Do not write the address. (10 points)", "letter", ["give your opinions briefly", "make two or three suggestions"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should\n\n1) describe the drawing briefly,\n2) explain its intended meaning, and then\n3) give your comments.", "You should write neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing briefly", "explain its intended meaning", "give your comments"]),
  },
  2010: {
    a: A("You are supposed to write for the Postgraduates’ Association a notice to recruit volunteers for an international conference on globalization. The notice should include the basic qualifications for applicants and other information which you think is relevant.", "You should write about 100 words on ANSWER SHEET 2. Do not sign your own name at the end of the notice. Use “Postgraduates’ Association” instead. (10 points)", "notice", ["include the basic qualifications for applicants", "include other information which you think is relevant"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should\n\n1) describe the drawing briefly,\n2) explain its intended meaning, and\n3) give your comments.", "You should write neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing briefly", "explain its intended meaning", "give your comments"]),
  },
  2011: {
    a: A("Write a letter to a friend of yours to\n\n1) recommend one of your favorite movies and\n2) give reasons for your recommendation.", "You should write about 100 words on ANSWER SHEET 2. Do not sign your own name at the end of the letter. Use “Li Ming” instead. Do not write the address. (10 points)", "letter", ["recommend one of your favorite movies", "give reasons for your recommendation"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should\n\n1) describe the drawing briefly,\n2) explain its intended meaning, and\n3) give your comments.", "You should write neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing briefly", "explain its intended meaning", "give your comments"]),
  },
  2012: {
    a: A("Some international students are coming to your university. Write them an email in the name of the Students’ Union to\n\n1) extend your welcome and\n2) provide some suggestions for their campus life here.", "You should write about 100 words on ANSWER SHEET 2. Do not sign your own name at the end of the letter. Use “Li Ming” instead. Do not write the address. (10 points)", "email", ["extend your welcome", "provide some suggestions for their campus life here"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay you should\n\n1) describe the drawing briefly,\n2) explain its intended meaning, and\n3) give your comments.", "You should write neatly on ANSWER SHEET 2. (20 points)", ["describe the drawing briefly", "explain its intended meaning", "give your comments"]),
  },
  2013: {
    a: A("Write an e-mail of about 100 words to a foreign teacher in your college, inviting him/her to be a judge for the upcoming English speech contest.\n\nYou should include the details you think necessary.", "You should write neatly on the ANSWER SHEET. Do not sign your own name at the end of the e-mail. Use “Li Ming” instead. Do not write the address. (10 points)", "email", ["invite him/her to be a judge for the upcoming English speech contest", "include the details you think necessary"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should\n\n1) describe the drawing briefly,\n2) interpret its intended meaning, and\n3) give your comments.", "You should write neatly on the ANSWER SHEET. (20 points)", ["describe the drawing briefly", "interpret its intended meaning", "give your comments"]),
  },
  2014: {
    a: A("Write a letter of about 100 words to the president of your university, suggesting how to improve students’ physical condition.\n\nYou should include the details you think necessary.", "You should write neatly on the ANSWER SHEET. Do not sign your own name at the end of the letter. Use “Li Ming” instead. Do not write the address. (10 points)", "letter", ["suggest how to improve students’ physical condition", "include the details you think necessary"]),
    b: B("Write an essay of 160–200 words based on the following drawing. In your essay, you should\n\n1) describe the drawing briefly,\n2) interpret its intended meaning, and\n3) give your comments.", "You should write neatly on the ANSWER SHEET. (20 points)", ["describe the drawing briefly", "interpret its intended meaning", "give your comments"]),
  },
  2015: {
    a: A("You are going to host a club reading session. Write an email of about 100 words recommending a book to the club members.\n\nYou should state reasons for your recommendation.", "You should write neatly on the ANSWER SHEET. Do not sign your own name at the end of the letter. Use “Li Ming” instead. Do not write the address. (10 points)", "email", ["recommend a book to the club members", "state reasons for your recommendation"]),
    b: B("Write an essay of 160–200 words based on the following picture. In your essay, you should\n\n1) describe the picture briefly,\n2) interpret its intended meaning, and\n3) give your comments.", "You should write neatly on the ANSWER SHEET. (20 points)", ["describe the picture briefly", "interpret its intended meaning", "give your comments"]),
  },
  2016: {
    a: A("Suppose you are a librarian in your university. Write a notice of about 100 words, providing the newly-enrolled international students with relevant information about the library.", "You should write neatly on the ANSWER SHEET. Do not sign your own name at the end of the notice. Use “Li Ming” instead. Do not write the address. (10 points)", "notice", ["provide the newly-enrolled international students with relevant information about the library"]),
    b: B("Write an essay of 160–200 words based on the following pictures. In your essay, you should\n\n1) describe the pictures briefly,\n2) interpret the meaning, and\n3) give your comments.", "You should write neatly on the ANSWER SHEET. (20 points)", ["describe the pictures briefly", "interpret the meaning", "give your comments"]),
  },
  2017: {
    a: A("You are to write an email to James Cook, a newly-arrived Australian professor, recommending some tourist attractions in your city. Please give reasons for your recommendation.", "You should write neatly on the ANSWER SHEET. Do not sign your own name at the end of the email. Use “Li Ming” instead. Do not write the address. (10 points)", "email", ["recommend some tourist attractions in your city", "give reasons for your recommendation"]),
    b: B("Write an essay of 160–200 words based on the following pictures. In your essay, you should\n\n1) describe the pictures briefly,\n2) interpret the meaning, and\n3) give your comments.", "You should write neatly on the ANSWER SHEET. (20 points)", ["describe the pictures briefly", "interpret the meaning", "give your comments"]),
  },
  2018: {
    a: A("Write an email to all international experts on campus, inviting them to attend the graduation ceremony. In your email, you should include time, place and other relevant information about the ceremony.", "You should write about 100 words neatly on the ANSWER SHEET. Do not use your own name at the end of the email. Use “Li Ming” instead. (10 points)", "email", ["invite them to attend the graduation ceremony", "include time, place and other relevant information about the ceremony"]),
    b: B("Write an essay of 160–200 words based on the picture below. In your essay, you should\n\n1) describe the picture briefly,\n2) interpret the meaning, and\n3) give your comments.", "You should write neatly on the ANSWER SHEET. (20 points)", ["describe the picture briefly", "interpret the meaning", "give your comments"]),
  },
  2019: {
    a: A("Suppose you are working for the “Aiding Rural Primary Schools” project of your university. Write an email to answer the inquiry from an international student volunteer, specifying the details of the project.", "You should write about 100 words on the ANSWER SHEET. Do not use your own name in the email; use “Li Ming” instead. (10 points)", "email", ["answer the inquiry from an international student volunteer", "specify the details of the project"]),
    b: B("Write an essay of 160–200 words based on the picture below. In your essay, you should\n\n1) describe the picture briefly,\n2) interpret the implied meaning, and\n3) give your comments.", "Write your answer on the ANSWER SHEET. (20 points)", ["describe the picture briefly", "interpret the implied meaning", "give your comments"]),
  },
  2020: {
    a: A("The student union of your university has assigned you to inform the international students about an upcoming singing contest. Write a notice in about 100 words.", "Write your answer on the ANSWER SHEET. Do not use your own name in the notice. (10 points)", "notice", ["inform the international students about an upcoming singing contest"]),
    b: B("Write an essay of 160–200 words based on the pictures below. In your essay, you should\n\n1) describe the pictures briefly,\n2) interpret the implied meaning, and\n3) give your comments.", "Write your answer on the ANSWER SHEET. (20 points)", ["describe the pictures briefly", "interpret the implied meaning", "give your comments"]),
  },
  2021: {
    a: A("A foreign friend of yours has recently graduated from college and intends to find a job in China. Write him/her an e-mail to make some suggestions.", "You should write about 100 words on the ANSWER SHEET. Do not use your own name in the email; use “Li Ming” instead. (10 points)", "email", ["make some suggestions about finding a job in China"]),
    b: B("Write an essay of 160–200 words based on the picture below. In your essay, you should\n\n1) describe the picture briefly,\n2) interpret the implied meaning, and\n3) give your comments.", "Write your answer on the ANSWER SHEET. (20 points)", ["describe the picture briefly", "interpret the implied meaning", "give your comments"]),
  },
  2022: {
    a: A("Write an email to a professor at a British university, inviting him/her to organize a team for the international innovation contest to be held at your university.", "You should write about 100 words on the ANSWER SHEET. Do not use your own name in the email; use “Li Ming” instead. (10 points)", "email", ["invite him/her to organize a team for the international innovation contest to be held at your university"]),
    b: B("Write an essay of 160–200 words based on the picture below. In your essay, you should\n\n1) describe the picture briefly,\n2) interpret the implied meaning, and\n3) give your comments.", "Write your answer on the ANSWER SHEET. (20 points)", ["describe the picture briefly", "interpret the implied meaning", "give your comments"]),
  },
  2023: {
    a: A("Write a notice to recruit a student for Prof. Smith’s research project on campus sports activities. Specify the duties and requirements of the job.", "Write your answer in about 100 words on the ANSWER SHEET. Do not use your own name in the notice; use “Li Ming” instead. (10 points)", "notice", ["specify the duties of the job", "specify the requirements of the job"]),
    b: B("Write an essay based on the picture below. In your essay, you should\n\n1) describe the picture briefly,\n2) interpret the implied meaning, and\n3) give your comments.", "Write your answer in 160–200 words on the ANSWER SHEET. (20 points)", ["describe the picture briefly", "interpret the implied meaning", "give your comments"]),
  },
};

export const writingQuestionSources = Object.freeze(Object.fromEntries(
  Object.entries(tasks).map(([yearText, yearTasks]) => {
    const year = Number(yearText);
    const [sourcePage, pageCount, sourceSha256, assetCrop] = sourceMeta[year];
    return [year, Object.freeze({ year, sourceFileName: pdf(year), sourcePage, pageCount, sourceSha256, assetCrop, tasks: Object.freeze(yearTasks) })];
  }),
));
