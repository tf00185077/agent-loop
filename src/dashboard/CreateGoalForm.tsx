import React, { useState } from "react";
import { createGoal } from "./api";

interface Props {
  onCreated: () => void;
}

const PRIORITIES = ["low", "medium", "high"];
const AGENT_TYPES = ["mock", "general"];

export default function CreateGoalForm({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [agentType, setAgentType] = useState("mock");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createGoal({ title, description, priority, agentType });
      setTitle("");
      setDescription("");
      setPriority("medium");
      setAgentType("mock");
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ marginBottom: 20, padding: "8px 16px", cursor: "pointer" }}
      >
        + New Goal
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        border: "1px solid #ddd",
        borderRadius: 6,
        padding: 20,
        marginBottom: 20,
      }}
    >
      <h3 style={{ marginTop: 0 }}>New Goal</h3>

      <label style={labelStyle}>
        Title
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>

      <div style={{ display: "flex", gap: 16 }}>
        <label style={{ ...labelStyle, flex: 1 }}>
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>

        <label style={{ ...labelStyle, flex: 1 }}>
          Agent Type
          <select value={agentType} onChange={(e) => setAgentType(e.target.value)} style={inputStyle}>
            {AGENT_TYPES.map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
      </div>

      {error && <p style={{ color: "red", margin: "8px 0" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="submit" disabled={submitting} style={{ padding: "8px 16px", cursor: "pointer" }}>
          {submitting ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ padding: "8px 16px", cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 12,
  fontSize: 14,
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 400,
};
