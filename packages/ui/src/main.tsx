import { BaseStyles, ThemeProvider } from "@primer/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LiveProvider } from "./live";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider colorMode="day">
      <BaseStyles>
        <LiveProvider>
          <App />
        </LiveProvider>
      </BaseStyles>
    </ThemeProvider>
  </StrictMode>,
);
