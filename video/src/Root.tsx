import React from "react";
import { Composition, Folder } from "remotion";

import { Promo, SCENES } from "./Promo";
import { FPS, TOTAL } from "./timeline";

import "./styles.css";

export const Root: React.FC = () => (
  <>
    <Composition
      id="Promo"
      component={Promo}
      width={1920}
      height={1080}
      fps={FPS}
      durationInFrames={TOTAL}
      defaultProps={{ bgm: true }}
    />
    <Folder name="Scenes">
      {SCENES.map(({ id, component, duration }) => (
        <Composition
          key={id}
          id={id}
          component={component}
          width={1920}
          height={1080}
          fps={FPS}
          durationInFrames={duration}
        />
      ))}
    </Folder>
  </>
);
