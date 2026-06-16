import React, { useState } from "react";

type View = { page: "list" } | { page: "detail"; goalId: string };

export default function App() {
  const [view, setView] = useState<View>({ page: "list" });

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <header style={{ borderBottom: "1px solid #ddd", paddingBottom: 12, marginBottom: 24 }}>
        <h1
          style={{ margin: 0, cursor: "pointer" }}
          onClick={() => setView({ page: "list" })}
        >
          auto-agent
        </h1>
      </header>
      <main>
        {view.page === "list" ? (
          <p style={{ color: "#888" }}>Goal list coming in 5.2</p>
        ) : (
          <p style={{ color: "#888" }}>Goal detail coming in 5.4</p>
        )}
      </main>
    </div>
  );
}
