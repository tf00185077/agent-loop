import React, { useState } from "react";
import GoalList from "./GoalList";
import CreateGoalForm from "./CreateGoalForm";
import GoalDetail from "./GoalDetail";

type View = { page: "list" } | { page: "detail"; goalId: string };

export default function App() {
  const [view, setView] = useState<View>({ page: "list" });
  const [refreshKey, setRefreshKey] = useState(0);

  function goList() {
    setView({ page: "list" });
    setRefreshKey((k) => k + 1);
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <header style={{ borderBottom: "1px solid #ddd", paddingBottom: 12, marginBottom: 24 }}>
        <h1 style={{ margin: 0, cursor: "pointer" }} onClick={goList}>
          auto-agent
        </h1>
      </header>
      <main>
        {view.page === "list" && (
          <>
            <CreateGoalForm onCreated={() => setRefreshKey((k) => k + 1)} />
            <GoalList
              refreshKey={refreshKey}
              onSelect={(id) => setView({ page: "detail", goalId: id })}
            />
          </>
        )}
        {view.page === "detail" && (
          <div>
            <button onClick={goList} style={{ marginBottom: 16 }}>← Back</button>
            <GoalDetail goalId={view.goalId} refreshKey={refreshKey} />
          </div>
        )}
      </main>
    </div>
  );
}
