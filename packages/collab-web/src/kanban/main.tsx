import { createRoot } from "react-dom/client";
import { KanbanApp } from "./App";
import "../styles/tokens.css";
import "../styles/base.css";
import "./kanban.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<KanbanApp />);
