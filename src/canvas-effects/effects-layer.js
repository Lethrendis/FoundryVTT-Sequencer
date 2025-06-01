import {
  EffectPlayer,
  InteractionManager,
  SelectionManager,
} from "../modules/sequencer-interaction-manager.js";
import * as canvaslib from "../lib/canvas-lib.js";
import CONSTANTS from "../constants.js";
import FoundryShim from "../utils/foundry-shim.js";

export class BaseEffectsLayer extends FoundryShim.InteractionLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      elevation: 100000000,
      name: CONSTANTS.EFFECTS_LAYER,
    });
  }
}

export class SequencerInterfaceLayer extends FoundryShim.InteractionLayer {
  constructor(...args) {
    super(...args);
  }

	isActive = false;

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      elevation: 100000000,
      name: CONSTANTS.INTERFACE_LAYER,
    });
  }

	activate(...args){
		const result = super.activate(...args);
		this.isActive = true;
		return result;
	}

  deactivate() {
    super.deactivate();
    if (!this.isActive) return;
    this._clearChildren();
    this.isActive = false;
    InteractionManager.tearDown();
  }

  _setup() {
    if (!this.UIContainer || this.UIContainer._destroyed) {
      this.UIContainer = new PIXI.Container();
      this.UIContainer.sortableChildren = true;
      this.UIContainer.parentName = "sequencerUIContainer";
      this.UIContainer.zIndex = 10000000000000;
      this.addChild(this.UIContainer);

      this.linePoint = this.UIContainer.addChild(new PIXI.Graphics());
      this.line = this.UIContainer.addChild(new PIXI.Graphics());
      this.lineHead = this.UIContainer.addChild(new PIXI.Graphics());
      this.suggestionPoint = this.UIContainer.addChild(new PIXI.Graphics());
      this.effectHoverBoxes = this.UIContainer.addChild(new PIXI.Graphics());
      this.effectSelectionBorder = this.UIContainer.addChild(
        new PIXI.Graphics()
      );
      this.effectSourcePosition = this.UIContainer.addChild(
        new PIXI.Graphics()
      );
      this.effectTargetPosition = this.UIContainer.addChild(
        new PIXI.Graphics()
      );

      this.suggestionPoint.filters = [new PIXI.AlphaFilter(0.75)];
      this.effectSourcePosition.filters = [new PIXI.AlphaFilter(0.75)];
      this.effectTargetPosition.filters = [new PIXI.AlphaFilter(0.75)];

      this.effectSelectionBorder.zIndex = 1;

      this.effectSourcePosition.interactive = true;
      this.effectSourcePosition.on("mousedown", () => {
        SelectionManager.sourcePointSelected();
      });

      this.effectTargetPosition.interactive = true;
      this.effectTargetPosition.on("mousedown", () => {
        SelectionManager.targetPointSelected();
      });
    }
  }

  async _draw(...args) {}

  render(...args) {
    super.render(...args);
    this._setup();
    this._clearChildren();
    this._drawHoveredEffectElements();
    if (!this.isActive) return;
    this._drawLine();
    this._drawPoints();
    this._drawSelectedEffectElements();
    this._drawSuggestionPoint();
  }

  _clearChildren() {
    if (!this.UIContainer) return;
    this.UIContainer.children.forEach((child) => {
      child.clear();
    });
  }

  _drawLine() {
    if (
      !EffectPlayer.startPos ||
      !EffectPlayer.endPos ||
      game?.activeTool !== CONSTANTS.TOOLS.PLAY
    )
      return;

    this.line.lineStyle(3, CONSTANTS.COLOR.PRIMARY, 1);
    // If line already present then set its position only
    this.line.moveTo(EffectPlayer.startPos.x, EffectPlayer.startPos.y);
    this.line.lineTo(EffectPlayer.endPos.x, EffectPlayer.endPos.y);
  }

  _drawPoints() {
    if (game?.activeTool !== CONSTANTS.TOOLS.PLAY) return;

    const startPos = EffectPlayer.startPos || EffectPlayer.cursorPos;

    this.linePoint.beginFill(CONSTANTS.COLOR.PRIMARY);
    this.linePoint.drawCircle(startPos.x, startPos.y, 5);

    if (EffectPlayer.sourceAttachFound) {
      this._drawCrossAtLocation(this.linePoint, startPos);
    }

    if (!EffectPlayer.endPos) return;

    const angle = new Ray(startPos, EffectPlayer.endPos).angle;

    this.lineHead.beginFill(CONSTANTS.COLOR.PRIMARY);
    this.lineHead.moveTo(0, -5);
    this.lineHead.lineTo(-15, 30);
    this.lineHead.lineTo(15, 30);
    this.lineHead.endFill();
    this.lineHead.rotation = angle + Math.PI / 2;
    this.lineHead.position.set(EffectPlayer.endPos.x, EffectPlayer.endPos.y);

    if (EffectPlayer.targetAttachFound) {
      this.linePoint.beginFill(CONSTANTS.COLOR.SECONDARY);
      this._drawCrossAtLocation(this.linePoint, EffectPlayer.endPos);
    }
  }

  _drawHoveredEffectElements() {
    const effects = new Set(SelectionManager.hoveredEffects);
    if (SelectionManager.hoveredEffectUI)
      effects.add(SelectionManager.hoveredEffectUI);
    for (const effect of effects) {
      if (
        !effect ||
        effect === SelectionManager.selectedEffect ||
        effect.data.screenSpace ||
        effect._isEnding
      )
        continue;
      this._drawBoxAroundEffect(this.effectHoverBoxes, effect);
    }
  }

  _drawSelectedEffectElements() {
    if (!SelectionManager.selectedEffect) return;
    this._drawBoxAroundEffect(
      this.effectSelectionBorder,
      SelectionManager.selectedEffect,
      true
    );
    this._drawEffectStartEndPoints(SelectionManager.selectedEffect);
  }

  _drawBoxAroundEffect(graphic, effect, selected = false) {
    if (
      !effect ||
      effect._destroyed ||
      !effect.spriteContainer ||
      !effect.ready
    )
      return;

    graphic.lineStyle(3, selected ? CONSTANTS.COLOR.PRIMARY : 0xffffff, 0.9);

    let boundingBox = effect.sprite.getLocalBounds();
    let dimensions = {
      x: effect.position.x + boundingBox.x * effect.sprite.scale.x,
      y: effect.position.y + boundingBox.y * effect.sprite.scale.y,
      width: boundingBox.width * effect.sprite.scale.x,
      height: boundingBox.height * effect.sprite.scale.y,
    };

    if (effect.data.shapes.length) {
      for (const shape of Object.values(effect.shapes)) {
        boundingBox = shape.getLocalBounds();
        dimensions = {
          x: Math.min(
            dimensions.x,
            effect.position.x + boundingBox.x * shape.scale.x
          ),
          y: Math.min(
            dimensions.y,
            effect.position.y + boundingBox.y * shape.scale.y
          ),
          width: Math.max(dimensions.width, boundingBox.width * shape.scale.x),
          height: Math.max(
            dimensions.height,
            boundingBox.height * shape.scale.y
          ),
        };
      }
    }

    const rotation = Math.normalizeRadians(
      effect.rotationContainer.rotation +
        effect.spriteContainer.rotation +
        effect.sprite.rotation
    );

    this._drawRectangle(graphic, effect.position, rotation, dimensions);
  }

  _drawRectangle(graphic, position, rotation, dimensions) {
    graphic.moveTo(
      ...canvaslib.rotate_coordinate(
        position,
        {
          x: dimensions.x,
          y: dimensions.y,
        },
        -rotation
      )
    );

    graphic.lineTo(
      ...canvaslib.rotate_coordinate(
        position,
        {
          x: dimensions.x + dimensions.width,
          y: dimensions.y,
        },
        -rotation
      )
    );

    graphic.lineTo(
      ...canvaslib.rotate_coordinate(
        position,
        {
          x: dimensions.x + dimensions.width,
          y: dimensions.y + dimensions.height,
        },
        -rotation
      )
    );

    graphic.lineTo(
      ...canvaslib.rotate_coordinate(
        position,
        {
          x: dimensions.x,
          y: dimensions.y + dimensions.height,
        },
        -rotation
      )
    );

    graphic.lineTo(
      ...canvaslib.rotate_coordinate(
        position,
        {
          x: dimensions.x,
          y: dimensions.y,
        },
        -rotation
      )
    );

    graphic.lineTo(
      ...canvaslib.rotate_coordinate(
        position,
        {
          x: dimensions.x + dimensions.width,
          y: dimensions.y,
        },
        -rotation
      )
    );
  }

  /**
   * Draws the start/end point circles
   * @private
   */
  _drawEffectStartEndPoints(effect) {
    if (!effect || effect._destroyed || !effect.spriteContainer) return;

    if (
      !effect.data.stretchTo ||
      !effect.sourcePosition ||
      !effect.targetPosition
    )
      return;

    this.effectSourcePosition.beginFill(CONSTANTS.COLOR.PRIMARY);
    this.effectSourcePosition.drawCircle(
      effect.sourcePosition.x,
      effect.sourcePosition.y,
      canvas.grid.size * 0.25
    );

    if (typeof effect.data.source === "string") {
      this._drawCrossAtLocation(
        this.effectSourcePosition,
        effect.sourcePosition
      );
    }

    this.effectTargetPosition.beginFill(CONSTANTS.COLOR.SECONDARY);
    this.effectTargetPosition.drawCircle(
      effect.targetPosition.x,
      effect.targetPosition.y,
      canvas.grid.size * 0.25
    );
    this.effectTargetPosition.alpha = 0.75;

    if (typeof effect.data.target === "string") {
      this._drawCrossAtLocation(
        this.effectTargetPosition,
        effect.targetPosition
      );
    }
  }

  _drawSuggestionPoint() {
    if (
      !SelectionManager.suggestedProperties ||
      !SelectionManager.selectedEffect
    )
      return;

    const effect = SelectionManager.selectedEffect;
    const suggestion = SelectionManager.suggestedProperties;

    this.suggestionPoint.position.set(0, 0);
    this.suggestionPoint.rotation = 0;

    if (effect.data.stretchTo) {
      this.suggestionPoint.beginFill(suggestion.color);
      this.suggestionPoint.drawCircle(
        suggestion.position.x,
        suggestion.position.y,
        canvas.grid.size * 0.25
      );
      if (suggestion.showCursor) {
        this._drawCrossAtLocation(this.suggestionPoint, suggestion.position);
      }
      return;
    }

    const boundingBox = effect.spriteContainer.getLocalBounds();

    const dimensions = {
      x: boundingBox.x * effect.scale.x,
      y: boundingBox.y * effect.scale.y,
      width: boundingBox.width * effect.scale.x,
      height: boundingBox.height * effect.scale.y,
    };

    this.suggestionPoint.lineStyle(3, CONSTANTS.COLOR.PRIMARY, 0.9);
    this.suggestionPoint.position.set(
      suggestion.position.x,
      suggestion.position.y
    );
    this._drawRectangle(
      this.suggestionPoint,
      suggestion.position,
      effect.rotation,
      dimensions,
      true
    );

    if (suggestion.showCursor) {
      this.suggestionPoint.beginFill(CONSTANTS.COLOR.SECONDARY);
      this._drawCrossAtLocation(this.suggestionPoint);
    }

    if (suggestion.showPoint) {
      this.suggestionPoint.drawCircle(0, 0, canvas.grid.size * 0.2);
    }
  }

  _drawCrossAtLocation(inElement, inPosition = { x: 0, y: 0 }) {
    inElement.drawRect(
      inPosition.x + canvas.grid.size * -0.05,
      inPosition.y + canvas.grid.size * -0.5,
      canvas.grid.size * 0.1,
      canvas.grid.size
    );
    inElement.drawRect(
      inPosition.x + canvas.grid.size * -0.5,
      inPosition.y + canvas.grid.size * -0.05,
      canvas.grid.size,
      canvas.grid.size * 0.1
    );
  }
}

export class UIEffectsLayer extends FoundryShim.InteractionLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      zIndex: 999999999999999,
      name: "sequencerEffectsAboveEverything",
    });
  }

  updateTransform() {
    if (this.sortableChildren && this.sortDirty) {
      this.sortChildren();
    }

    this._boundsID++;

    this.transform.updateTransform(PIXI.Transform.IDENTITY);
    this.worldAlpha = this.alpha;

    for (let child of this.children) {
      if (child.visible) {
        child.updateTransform();
      }
    }
  }
}

let layer = false;

export class SequencerAboveUILayer {
  constructor(name, zIndex = 0.1) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = name;

    this.canvas.style.cssText = `
            position:absolute;
            touch-action: none;
            pointer-events: none;
            width:100%;
            height:100%;
            z-index:${zIndex};
            padding: 0;
            margin: 0;
        `;

    document.body.appendChild(this.canvas);

    this.app = new PIXI.Application({
      width: window.innerWidth,
      height: window.innerHeight,
      view: this.canvas,
      antialias: true,
      backgroundAlpha: 0.0,
      sharedTicker: true,
    });

    this.app.resizeTo = window;
    this.app.stage.renderable = false;
  }

  static setup() {
    if (!game.settings.get("sequencer", "enable-above-ui-screenspace")) return;
    layer = new this("sequencerUILayerAbove", 10000);
  }

  static getLayer() {
    return layer ? layer.app.stage : canvas.sequencerEffectsUILayer;
  }

  static addChild(...args) {
		const layer = this.getLayer();
    const result = layer.addChild(...args);
		layer.renderable = layer.children.length > 0;
    return result;
  }

  static sortChildren() {
    return this.getLayer().sortChildren();
  }

  static removeContainerByEffect(inEffect) {
		const layer = this.getLayer();
		if (!(layer instanceof SequencerAboveUILayer)) return;

    const child = layer.children.find((child) => child === inEffect);
    if (!child) return;
    layer.removeChild(child);

    layer.renderable = layer.children.length > 0;
  }

  updateTransform() {
    if (this.app.stage.sortableChildren && this.app.stage.sortDirty) {
      this.app.stage.sortChildren();
    }

    this.app.stage._boundsID++;

    this.app.stage.transform.updateTransform(PIXI.Transform.IDENTITY);
    this.app.stage.worldAlpha = this.app.stage.alpha;

    for (let child of this.app.stage.children) {
      if (child.visible) {
        child.updateTransform();
      }
    }
  }
}
