export const fixtures = [
  {
    name: "linear",
    source: "flowchart LR\n  A[Mermaid source] --> B[Pele SVG] --> C[Kitty PNG]",
  },
  {
    name: "branching",
    source: `flowchart LR
  A[Receive order] --> B{In stock?}
  B -->|Yes| C[Reserve items]
  B -->|No| D[Offer substitute]
  C --> E[Confirm order]
  D --> E`,
  },
  {
    name: "sequence",
    source: `sequenceDiagram
  participant S as Shopper
  participant A as API
  participant I as Inventory
  S->>A: Place order
  activate A
  Note over A,I: Stock check
  A->>I: Check stock
  I-->>A: Available
  A-->>S: Order confirmed
  deactivate A`,
  },
].map((fixture) => {
  const fence = `\`\`\`mermaid\n${fixture.source}\n\`\`\``;
  return { ...fixture, fence, sample: `Before the diagram.\n\n${fence}\n\nAfter the diagram.` };
});
