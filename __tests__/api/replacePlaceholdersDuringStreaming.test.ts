import { replacePlaceholdersDuringStreaming } from "../../lib/edge-runtime/angelaUtils";
import tokenizer from "gpt-tokenizer";

describe("replacePlaceholdersDuringStreaming", () => {
  it("no placeholders", () => {
    const out = replacePlaceholdersDuringStreaming(
      "This is a test string",
      "",
      {},
    );
    expect(out.content).toEqual("This is a test string");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("placeholder, but none in string", () => {
    const out = replacePlaceholdersDuringStreaming(
      "This is a test string",
      "",
      {
        URL1: "https://google.com",
      },
    );
    expect(out.content).toEqual("This is a test string");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("ID in string, but not at the end", () => {
    const out = replacePlaceholdersDuringStreaming("ID ", "", {
      URL1: "https://google.com",
    });
    expect(out.content).toEqual("ID ");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("placeholder, ID included", () => {
    const out = replacePlaceholdersDuringStreaming("ID", "", {
      URL1: "https://google.com",
    });
    expect(out.content).toEqual("");
    expect(out.placeholderBuffer).toEqual("ID");
  });
  it("placeholder, buffer filled, no match", () => {
    const out = replacePlaceholdersDuringStreaming(" baby", "URL", {
      URL1: "https://google.com",
    });
    expect(out.content).toEqual("URL baby");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("placeholder, matches format, no match", () => {
    const out = replacePlaceholdersDuringStreaming("2 ", "URL", {
      URL1: "https://google.com",
    });
    expect(out.content).toEqual("URL2 ");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("placeholder in 1 chunk, match", () => {
    const out = replacePlaceholdersDuringStreaming("content=URL1 ", "", {
      URL1: "https://google.com",
    });
    expect(out.content).toEqual("content=https://google.com ");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("URL, buffer filled, match", () => {
    const out = replacePlaceholdersDuringStreaming("1 ", "URL", {
      URL1: "https://google.com",
    });
    expect(out.content).toEqual("https://google.com ");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("ID, buffer filled, match", () => {
    const out = replacePlaceholdersDuringStreaming("2 ", "ID", {
      ID1: "ff3a5-3f3a5-3f3a5-3f3a5",
      ID2: "ff3a5-3f3a5-3f3a5-77877",
    });
    expect(out.content).toEqual("ff3a5-3f3a5-3f3a5-77877 ");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("FUNCTION, put in buffer", () => {
    const out = replacePlaceholdersDuringStreaming("FUNCTION", "", {
      FUNCTIONS: "functions",
      FUNCTION: "function",
    });
    expect(out.content).toEqual("");
    expect(out.placeholderBuffer).toEqual("FUNCTION");
  });
  it("FUNCTION, match", () => {
    const out = replacePlaceholdersDuringStreaming(" is", "FUNCTION", {
      FUNCTIONS: "functions",
      FUNCTION: "function",
    });
    expect(out.content).toEqual("function is");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("FUNCTIONS, ", () => {
    const out = replacePlaceholdersDuringStreaming("S ", "FUNCTION", {
      FUNCTIONS: "functions",
      FUNCTION: "function",
    });
    expect(out.content).toEqual("functions ");
    expect(out.placeholderBuffer).toEqual("");
  });
  it("URLs in markdown links", () => {
    const textToStream = `1. [10 Healthiest Fruits To Eat Every Day - Eat This Not That](URL1)
  2. [12 Healthiest Fruits to Eat, According to Nutrutionists - Prevention](URL2)
  3. [Best Fruits to Eat: A Dietitian's Picks - Cleveland Clinic Health ...](URL3)`;
    const tokens = tokenizer.encode(textToStream);
    const placeHolderMap = {
      URL1: "https://www.eatthis.com/healthiest-fruits/",
      URL2: "https://www.prevention.com/food-nutrition/g20484029/healthiest-fruits/",
      URL3: "https://health.clevelandclinic.org/10-best-fruits-to-eat/",
    };
    let placeholderBuffer = "",
      content = "",
      entireContent = "";
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const encodedToken = tokenizer.decode([token]);
      ({ content, placeholderBuffer } = replacePlaceholdersDuringStreaming(
        encodedToken,
        placeholderBuffer,
        placeHolderMap,
      ));
      entireContent += content;
    }
    expect(entireContent)
      .toEqual(`1. [10 Healthiest Fruits To Eat Every Day - Eat This Not That](https://www.eatthis.com/healthiest-fruits/)
  2. [12 Healthiest Fruits to Eat, According to Nutrutionists - Prevention](https://www.prevention.com/food-nutrition/g20484029/healthiest-fruits/)
  3. [Best Fruits to Eat: A Dietitian's Picks - Cleveland Clinic Health ...](https://health.clevelandclinic.org/10-best-fruits-to-eat/)`);
  });
});
