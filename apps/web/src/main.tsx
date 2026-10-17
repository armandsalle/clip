import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VideoId } from "@clip/domain";
import { Coulisses } from "./Coulisses.tsx";
import { Home } from "./Home.tsx";
import { useRoute } from "./util.ts";
import { VideoPage } from "./VideoPage.tsx";
import "./styles.css";

const App = () => {
  const route = useRoute();
  switch (route.page) {
    case "home":
      return <Home />;
    case "video":
      return <VideoPage key={route.id} id={VideoId.make(route.id)} />;
    case "coulisses":
      return <Coulisses key={route.id} id={VideoId.make(route.id)} />;
  }
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
