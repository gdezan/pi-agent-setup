import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { generate, parse, walk } from "css-tree";

function resolveCss(source, variables, context = "value", resolving = new Set()) {
  const ast = parse(source, { context, parseCustomProperty: true });
  walk(ast, {
    visit: "Function",
    enter(node) {
      if (node.name !== "var") return;
      const [name, , ...fallback] = node.children.toArray();
      if (name?.type !== "Identifier" || resolving.has(name.name))
        throw new Error("Invalid CSS variable");
      const value = variables.get(name.name) ?? fallback.map(generate).join("");
      if (!value) throw new Error(`Unresolved CSS variable: ${name.name}`);
      const next = new Set(resolving).add(name.name);
      node.type = "Raw";
      node.value = resolveCss(value, variables, "value", next);
      delete node.name;
      delete node.children;
    },
  });
  return generate(ast);
}

export function resolvePeleSvg(svg, palette) {
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(svg, "image/svg+xml");
  function visit(element, inherited) {
    const variables = new Map(inherited);
    const styles = parse(element.getAttribute("style") ?? "", {
      context: "declarationList",
      parseCustomProperty: true,
    });
    styles.children.forEach((declaration) => {
      if (declaration.type === "Declaration" && declaration.property.startsWith("--")) {
        variables.set(declaration.property, generate(declaration.value));
      }
    });
    if (element === document.documentElement) {
      for (const [name, value] of Object.entries(palette)) variables.set(name, value);
    }
    styles.children.forEach((declaration, item, list) => {
      if (declaration.type !== "Declaration") throw new Error("Unsupported SVG style");
      if (declaration.property.startsWith("--")) {
        list.remove(item);
      } else {
        const value = resolveCss(generate(declaration.value), variables);
        declaration.value = parse(value, { context: "value" });
        // resvg does not implement CSS geometry properties on SVG shapes.
        if (declaration.property === "rx" || declaration.property === "ry")
          element.setAttribute(declaration.property, value);
      }
    });
    if (styles.children.isEmpty) element.removeAttribute("style");
    else element.setAttribute("style", generate(styles));
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.value.includes("var("))
        element.setAttribute(attribute.name, resolveCss(attribute.value, variables));
    }
    if (element.localName === "style")
      element.textContent = resolveCss(element.textContent, variables, "stylesheet");
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === child.ELEMENT_NODE) visit(child, variables);
    }
  }
  visit(document.documentElement, new Map());
  return new XMLSerializer().serializeToString(document);
}
