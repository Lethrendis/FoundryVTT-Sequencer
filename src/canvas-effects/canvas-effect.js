import CONSTANTS from "../constants.js";
import * as canvaslib from "../lib/canvas-lib.js";
import filters from "../lib/filters.js";
import MaskFilter from "../lib/filters/mask-filter.js";
import * as lib from "../lib/lib.js";
import SequencerAnimationEngine from "../modules/sequencer-animation-engine.js";
import SequencerEffectManager from "../modules/sequencer-effect-manager.js";
import { SequencerFileBase } from "../modules/sequencer-file.js";
import { sequencerSocket, SOCKET_HANDLERS } from "../sockets.js";
import flagManager from "../utils/flag-manager.js";
import { SequencerAboveUILayer } from "./effects-layer.js";
import { SequencerSpriteManager } from "./sequencer-sprite-manager.js";
import CrosshairsPlaceable from "../modules/sequencer-crosshair/CrosshairsPlaceable.js";
import PluginsManager from "../utils/plugins-manager.js";

const hooksManager = {
	_hooks: new Map(),
	_hooksRegistered: new Set(),

	addHook(effectUuid, hookName, callable, callNow = false) {
		if (!this._hooksRegistered.has(hookName)) {
			lib.debug("registering hook for: " + hookName);
			this._hooksRegistered.add(hookName);
			Hooks.on(hookName, (...args) => {
				this._hookCalled(hookName, ...args);
			});
		}

		const key = hookName + "-" + effectUuid;

		if (!this._hooks.has(key)) {
			this._hooks.set(key, []);
		}

		this._hooks.get(key).push(callable);

		if (callNow) {
			setTimeout(() => {
				callable();
			}, 20);
		}
	},

	_hookCalled(hookName, ...args) {
		Array.from(this._hooks)
			.filter((entry) => entry[0].startsWith(hookName + "-"))
			.map((hooks) => hooks[1])
			.deepFlatten()
			.forEach((callback) => callback(...args));
	},

	removeHooks(effectUuid) {
		Array.from(this._hooks)
			.filter((entry) => entry[0].endsWith("-" + effectUuid))
			.forEach((entry) => this._hooks.delete(entry[0]));
	},
};

const SyncGroups = {
	times: new Map(),
	effectIds: new Map(),

	get(effect) {
		const fullName = effect.data.sceneId + "-" + effect.data.syncGroup;
		const effectIds = new Set(this.effectIds.get(fullName));
		if (effectIds && !effectIds.has(effect.id)) {
			effectIds.add(effect.id);
			this.effectIds.set(fullName, Array.from(effectIds));
		}
		return this.times.get(fullName);
	},

	set(effect) {
		const fullName = effect.data.sceneId + "-" + effect.data.syncGroup;
		this.times.set(fullName, effect.data.creationTimestamp);
		this.effectIds.set(fullName, [effect.id]);
	},

	remove(effect) {
		const fullName = effect.data.sceneId + "-" + effect.data.syncGroup;
		const effectIds = new Set(this.effectIds.get(fullName));
		effectIds.delete(effect.id);
		if (effectIds.size) {
			this.effectIds.set(fullName, Array.from(effectIds));
		} else {
			this.effectIds.delete(fullName);
			this.times.delete(fullName);
		}
	}
};

export default class CanvasEffect extends PIXI.Container {
	#elevation = 0;
	#sort = 0;
	#sortLayer = 800

	constructor(inData) {
		super();

		this.sortableChildren = true;
		this.interactiveChildren = false;

		// Set default values
		this.actualCreationTime = +new Date();
		this.data = inData;

		this._resolve = null;
		this._durationResolve = null;

		this.ready = false;
		this._ended = false;
		this._isEnding = false;

		this._cachedSourceData = {};
		this._cachedTargetData = {};
		this.sourceOffset = { x: 0, y: 0 };
		this.targetOffset = { x: 0, y: 0 };

		this.uuid = false;

	}

	static get protectedValues() {
		return [
			"_id",
			"sequenceId",
			"creationTimestamp",
			"creatorUserId",
			"moduleName",
			"index",
			"repetition",
			"moves",
			"fadeIn",
			"fadeOut",
			"scaleIn",
			"scaleOut",
			"rotateIn",
			"rotateOut",
			"fadeInAudio",
			"fadeOutAudio",
			"animations",
			"nameOffsetMap",
			"persist",
		];
	}

	/** @type {number} */
	get elevation() {
		return this.#elevation;
	}

	set elevation(value) {
		this.#elevation = value;
	}

	/** @type {number} */
	get sort() {
		return this.#sort;
	}

	set sort(value) {
		this.#sort = value;
	}

	/** @type {number} */
	get sortLayer() {
		return this.#sortLayer;
	}

	set sortLayer(value) {
		this.#sortLayer = value;
	}

	get context() {
		return this.data.attachTo?.active && this.sourceDocument
			? this.sourceDocument
			: game.scenes.get(this.data.sceneId);
	}

	get creationTimestamp() {
		if (this.data.syncGroup) {
			const time = SyncGroups.get(this);
			if (time) return time;
			SyncGroups.set(this)
		}
		return this.data.creationTimestamp;
	}

	/**
	 * The ID of the effect
	 *
	 * @returns {string}
	 */
	get id() {
		return this.data._id;
	}

	/**
	 * Whether this effect is destroyed or is in the process of being destroyed
	 */
	get isDestroyed() {
		return (
			this.destroyed ||
			(this.source && this.isSourceDestroyed) ||
			(this.target && this.isTargetDestroyed)
		);
	}

	/**
	 * Whether the source of this effect is temporary
	 *
	 * @returns {boolean}
	 */
	get isSourceTemporary() {
		return (
			this.data.attachTo?.active &&
			this.sourceDocument &&
			!lib.is_UUID(this.sourceDocument?.uuid)
		);
	}

	/**
	 * Whether the source of this effect has been destroyed
	 *
	 * @returns {boolean}
	 */
	get isSourceDestroyed() {
		return (
			this.source && this.source?.destroyed && (!this.sourceDocument?.object || this.sourceDocument?.object?.destroyed || this.source.constructor.name === "Crosshairs")
		);
	}

	/**
	 * Whether the target of this effect is temporary
	 *
	 * @returns {boolean}
	 */
	get isTargetTemporary() {
		return (
			(this.data.stretchTo?.attachTo || this.data.rotateTowards?.attachTo) &&
			this.targetDocument &&
			!lib.is_UUID(this.targetDocument.uuid)
		);
	}

	/**
	 * Whether the target of this effect has been destroyed
	 *
	 * @returns {boolean}
	 */
	get isTargetDestroyed() {
		return (
			this.target && this.target?.destroyed && (!this.targetDocument?.object || this.targetDocument?.object?.destroyed || this.target.constructor.name === "Crosshairs")
		);
	}

	/**
	 * The source object (or source location) of the effect
	 *
	 * @returns {boolean|object}
	 */
	get source() {
		if (!this._source && this.data.source) {
			const getDifferentTarget = this.data.source === this.data.target;
			this._source = this._getObjectByID(this.data.source?.uuid ?? this.data.source, getDifferentTarget, true) ?? this.data.source;
			this._source = this._source?._object ?? this._source;
		}
		return this._source;
	}

	/**
	 * Retrieves the source document
	 *
	 * @returns {Document|PlaceableObject}
	 */
	get sourceDocument() {
		return this.source?.document ?? this.source;
	}

	/**
	 * Retrieves the PIXI object for the source object
	 *
	 * @returns {*|PIXI.Sprite|TileHUD<Application.Options>}
	 */
	get sourceMesh() {
		return this.source?.mesh ?? this.source?.template;
	}

	/**
	 * The source position with the relevant offsets calculated
	 *
	 * @returns {{x: number, y: number}}
	 */
	get sourcePosition() {
		let position = this.getSourceData().position;
		let offset = this._getOffset(this.data.source, true);

		if (this.data.attachTo?.active && this.data.attachTo?.align && this.data.attachTo?.align !== "center") {
			const additionalOffset = canvaslib.align({
				context: this.source,
				spriteWidth: this.sprite.width,
				spriteHeight: this.sprite.height,
				align: this.data.attachTo?.align,
				edge: this.data.attachTo?.edge,
			});

			offset.x += additionalOffset.x;
			offset.y += additionalOffset.y;
		}

		return {
			x: (position.x - offset.x) + this.sourceOffset.x,
			y: (position.y - offset.y) + this.sourceOffset.y,
		};
	}

	/**
	 * The target object (or target location) of the effect
	 *
	 * @returns {boolean|object}
	 */
	get target() {
		if (!this._target && this.data.target) {
			const getDifferentTarget = this.data.source === this.data.target;
			this._target = this._getObjectByID(this.data.target?.uuid ?? this.data.target, getDifferentTarget, false) ?? this.data.target;
			this._target = this._target?._object ?? this._target;
		}
		return this._target;
	}

	/**
	 * Retrieves the document of the target
	 *
	 * @returns {Document|PlaceableObject}
	 */
	get targetDocument() {
		return this.target?.document ?? this.target;
	}

	/**
	 * Retrieves the PIXI object for the target object
	 *
	 * @returns {*|PIXI.Sprite|TileHUD<Application.Options>}
	 */
	get targetMesh() {
		return this.target?.mesh ?? this.target?.template;
	}

	/**
	 * The target position with the relevant offsets calculated
	 *
	 * @returns {{x: number, y: number}}
	 */
	get targetPosition() {
		const position = this.getTargetData().position;
		const offset = this._getOffset(this.data.target);

		return {
			x: (position.x - offset.x) + this.targetOffset.x,
			y: (position.y - offset.y) + this.targetOffset.y,
		};
	}

	/**
	 * Returns this effect's world position
	 *
	 * @returns {{x: number, y: number}}
	 */
	get worldPosition() {
		const t = canvas.stage.worldTransform;
		return {
			x: (this.sprite.worldTransform.tx - t.tx) / canvas.stage.scale.x,
			y: (this.sprite.worldTransform.ty - t.ty) / canvas.stage.scale.y,
		};
	}

	/**
	 * Whether the current user is the owner of this effect
	 *
	 * @returns {boolean}
	 */
	get owner() {
		return this.data.creatorUserId === game.user.id;
	}

	get loopDelay() {
		return (this.data.loopOptions?.loopDelay ?? 0);
	}

	get loops() {
		return (this.data.loopOptions?.loops ?? 0);
	}

	/**
	 * Whether the current user can update this effect
	 *
	 * @returns {boolean}
	 */
	get userCanUpdate() {
		return (
			game.user.isGM ||
			this.owner ||
			(this.data.attachTo?.active &&
				this.sourceDocument.canUserModify(game.user, "update"))
		);
	}

	/**
	 * Whether the current user can delete this effect
	 *
	 * @returns {boolean}
	 */
	get userCanDelete() {
		return this.userCanUpdate || lib.user_can_do("permissions-effect-delete");
	}

	/**
	 * Whether this effect is on the current scene
	 *
	 * @returns {boolean}
	 */
	get onCurrentScene() {
		return this.data.sceneId === game.user.viewedScene;
	}

	/**
	 * Whether this effect should be shown as faded or not - effects created by users for other users should be shown
	 * for all
	 *
	 * @returns {boolean}
	 */
	get shouldShowFadedVersion() {
		// If the user has not set the opacity user-specific effects to 0
		// And it is not an effect that is only played for the user who created the effect
		// And if the effect is going to be played for a subset of users
		// And the users does not contain this user
		return (
			this.data.users &&
			this.data.users.length &&
			!(
				this.data.users.length === 1 &&
				this.data.users.includes(this.data.creatorUserId)
			) &&
			!this.data.users.includes(game.userId)
		);
	}

	set effectAlpha(value) {
		if (this.sprite) {
			this.sprite.alpha = value
		}
		if (this.shapes) {
			Object.values(this.shapes).forEach(shape => {
				shape.alpha = value
			})
		}
	}

	get effectAlpha() {
		return this.sprite?.alpha
	}

	async playMedia() {
		if (this.destroyed || this._ended || this._isEnding) {
			return
		}
		await this.sprite.play()
		this._setupTimestampHook(this.mediaCurrentTime * 1000);
	}

	updateTexture() {
		this.sprite.updateVideoTextures()
	}

	async pauseMedia() {
		this.sprite.stop()
	}

	get mediaLooping() {
		return this.sprite.loop
	}

	set mediaLooping(looping) {
		return this.sprite.loop = looping
	}

	get mediaIsPlaying() {
		return this.sprite.playing
	}

	get mediaCurrentTime() {
		return this.sprite.currentTime
	}

	get mediaPlaybackRate() {
		return this.sprite.playbackRate
	}

	set mediaPlaybackRate(inPlaybackRate) {
		// Playbackrate for spritesheets is now handled by timing info in the animation sequence
		this.sprite.playbackRate = inPlaybackRate;
	}

	set mediaCurrentTime(newTime) {
		this.sprite.currentTime = newTime
	}

	get mediaDuration() {
		return this.sprite.duration
	}

	get mediaDurationMs(){
		return this.mediaDuration * 1000
	}

	get hasAnimatedMedia() {
		return this.sprite.hasAnimatedMedia
	}

	/**
	 * The template of the effect, determining the effect's internal grid size, and start/end padding
	 *
	 * @returns {object}
	 */
	get template() {
		return this._template
	}

	/**
	 * The grid size difference between the internal effect's grid vs the grid on the canvas. If the effect is in screen space, we ignore this.
	 *
	 * @returns {number}
	 */
	get gridSizeDifference() {
		return canvas.grid.size / (this.template?.gridSize ?? this.defaultGridSize);
	}

	get defaultGridSize() {
		return 100
	}

	/**
	 * Whether the effect should be flipped on any given axis
	 *
	 * @returns {number}
	 */
	get flipX() {
		const offsetMap = this._nameOffsetMap?.[this.data.source];
		let flip = this.data.flipX ? -1 : 1
		if(offsetMap && offsetMap.mirrorX !== undefined) {
			flip *= offsetMap.mirrorX ? -1 : 1;
		}
		return flip;
	}

	get flipY() {
		const offsetMap = this._nameOffsetMap?.[this.data.source];
		let flip = this.data.flipY ? -1 : 1
		if(offsetMap && offsetMap.mirrorY !== undefined) {
			flip *= offsetMap.mirrorY ? -1 : 1;
		}
		return flip;
	}

	/**
	 * Whether this effect should play at all, depending on a multitude of factors
	 *
	 * @returns {boolean}
	 */
	get shouldPlay() {
		return (
			(game.user.viewedScene === this.data.sceneId ||
				this.data.creatorUserId === game.userId) &&
			(game.user.isGM ||
				!this.data.users ||
				this.data.users.length === 0 ||
				this.data.users.includes(game.userId))
		);
	}

	get shouldPlayVisible() {
		let playVisible =
			this.shouldPlay &&
			game.settings.get("sequencer", "effectsEnabled") &&
			game.user.viewedScene === this.data.sceneId;

		if (game.settings.get("core", "photosensitiveMode")) {
			playVisible = false;
			lib.throttled_custom_warning(
				this.data.moduleName,
				"Photosensitive Mode is turned on, so Sequencer's visual effects aren't being rendered"
			);
		}

		return playVisible;
	}

	static make(inData) {
		return !inData.persist
			? new CanvasEffect(inData)
			: new PersistentCanvasEffect(inData);
	}

	static checkValid(effectData) {
		if (effectData.delete) {
			return false;
		}
		let sourceExists = true;
		let targetExists = true;
		if (effectData.source && lib.is_UUID(effectData.source)) {
			sourceExists = fromUuidSync(effectData.source);
		}
		if (effectData.target && lib.is_UUID(effectData.target)) {
			targetExists = fromUuidSync(effectData.target);
		}
		for (let tiedDocumentUuid of effectData?.tiedDocuments ?? []) {
			if (tiedDocumentUuid && lib.is_UUID(tiedDocumentUuid)) {
				let tiedDocumentExists = fromUuidSync(tiedDocumentUuid);
				if (!tiedDocumentExists) return false;
			}
		}
		if (
			effectData.source &&
			lib.is_UUID(effectData.source) &&
			effectData.target &&
			lib.is_UUID(effectData.target)
		) {
			const sourceScene = effectData.source.split(".")[1];
			const targetScene = effectData.target.split(".")[1];
			if (sourceScene !== targetScene || sourceScene !== effectData.sceneId)
				return false;
		}
		return sourceExists && targetExists;
	}

	/**
	 * Validates that the update contains the appropriate data
	 *
	 * @param inUpdates
	 */
	static validateUpdate(inUpdates) {
		const updateKeys = Object.keys(inUpdates);
		const protectedValues = updateKeys.filter((key) =>
			CanvasEffect.protectedValues.includes(key)
		);
		if (protectedValues.length) {
			throw lib.custom_error(
				"Sequencer",
				`CanvasEffect | update | You cannot update the following keys of an effect's data: ${protectedValues.join(
					"\n - "
				)}`
			);
		}
		if (updateKeys.includes("source")) {
			if (
				!(
					lib.is_UUID(inUpdates.source) ||
					canvaslib.is_object_canvas_data(inUpdates.source)
				)
			) {
				throw lib.custom_error(
					"Sequencer",
					`CanvasEffect | update | source must be of type document UUID or object with X and Y coordinates`
				);
			}
		}
		if (updateKeys.includes("target")) {
			if (
				!(
					lib.is_UUID(inUpdates.target) ||
					canvaslib.is_object_canvas_data(inUpdates.target)
				)
			) {
				throw lib.custom_error(
					"Sequencer",
					`CanvasEffect | update | target must be of type document UUID or object with X and Y coordinates`
				);
			}
		}
	}

	getHook(type, uuid) {
		if (!lib.is_UUID(uuid)) return false;
		const parts = uuid.split(".");
		return type + parts[parts.length - 2];
	}

	/**
	 * Gets the source hook name
	 *
	 * @param {string} type
	 * @returns {string|boolean}
	 */
	getSourceHook(type = "") {
		return this.getHook(type, this.data.source);
	}

	/**
	 * The source object's current position, or its current position
	 *
	 * @returns {boolean|object}
	 */
	getSourceData() {

		if (this.data.temporary && !this.owner) {
			return SequencerEffectManager.getPositionForUUID(this.data.source);
		}

		if (this.source instanceof PlaceableObject && this.isSourceDestroyed){
			return {
				...this._cachedSourceData,
			};
		}

		let crosshairPos = this.source instanceof CrosshairsPlaceable ? this.sourceDocument.getOrientation() : false;
		crosshairPos = crosshairPos?.source;

		let position =
			this.source instanceof PlaceableObject && !this.isSourceTemporary
				? canvaslib.get_object_position(this.source)
				: crosshairPos || this.source?.worldPosition || this.source?.center || this.source;

		const { width, height } = crosshairPos || canvaslib.get_object_dimensions(this.source);

		position = PluginsManager.sourcePosition({ effect: this, position, height });

		if (position !== undefined) {
			this._cachedSourceData.position = position;
		}

		if (width !== undefined && height !== undefined) {
			this._cachedSourceData.width = width;
			this._cachedSourceData.height = height;
		}

		let rotation = 0;
		if (this.source instanceof MeasuredTemplate && this.sourceDocument?.t !== "rect") {
			rotation = Math.normalizeRadians(
				Math.toRadians(this.sourceDocument?.direction)
			);
		} else if (!(this.source instanceof MeasuredTemplate)) {
			rotation = this.sourceDocument?.rotation
				? Math.normalizeRadians(Math.toRadians(this.sourceDocument?.rotation))
				: 0;
		}

		if (rotation !== undefined) {
			this._cachedSourceData.rotation = rotation;
		}

		const alpha =
			this.sourceDocument instanceof TokenDocument || this.sourceDocument instanceof TileDocument
				? this.sourceDocument?._source?.alpha ?? 1.0
				: 1.0;

		if (alpha !== undefined) {
			this._cachedSourceData.alpha = alpha;
		}

		return {
			...this._cachedSourceData,
		};
	}

	/**
	 * Gets the target hook name
	 *
	 * @param {string} type
	 * @returns {string|boolean}
	 */
	getTargetHook(type = "") {
		return this.getHook(type, this.data.target);
	}

	/**
	 * The target object's current position, or its current position
	 *
	 * @returns {boolean|object}
	 */
	getTargetData() {

		if (this.data.temporary && !this.owner) {
			return (
				SequencerEffectManager.getPositionForUUID(this.data.target) ??
				this.getSourceData()
			);
		}

		if (this.target instanceof PlaceableObject && this.isTargetDestroyed){
			return {
				...this._cachedTargetData,
			};
		}

		let crosshairPos = this.target instanceof CrosshairsPlaceable ? this.targetDocument.getOrientation() : false;
		crosshairPos = crosshairPos?.target ?? crosshairPos?.source;

		let position =
			this.target instanceof PlaceableObject && !this.isTargetTemporary && !this.isTargetDestroyed
				? canvaslib.get_object_position(this.target, { measure: true })
				: crosshairPos || this.target?.worldPosition || this.target?.center || this.target;

		const { width, height } = crosshairPos || canvaslib.get_object_dimensions(this.target);

		position = PluginsManager.targetPosition({ effect: this, position, height });

		if (width !== undefined && height !== undefined) {
			this._cachedTargetData.width = width;
			this._cachedTargetData.height = height;
		}

		if (position !== undefined) {
			this._cachedTargetData.position = position;
		}

		let rotation = 0;
		if (
			this.target instanceof MeasuredTemplate &&
			this.targetDocument?.t !== "rect"
		) {
			rotation = Math.normalizeRadians(
				Math.toRadians(this.targetDocument?.direction)
			);
		} else if (!(this.target instanceof MeasuredTemplate)) {
			rotation = this.targetDocument?.rotation
				? Math.normalizeRadians(Math.toRadians(this.targetDocument?.rotation))
				: 0;
		}

		if (rotation !== undefined) {
			this._cachedTargetData.rotation = rotation;
		}

		const alpha =
			this.targetDocument instanceof TokenDocument ||
			this.targetDocument instanceof TileDocument
				? this.targetDocument?.alpha ?? 1.0
				: 1.0;

		if (alpha !== undefined) {
			this._cachedTargetData.alpha = alpha;
		}

		return {
			...this._cachedTargetData,
		};
	}

	/**
	 * Calculates the offset for a given offset property and name mapping
	 *
	 * @param {string} offsetMapName
	 * @param {boolean} source
	 * @returns {{x: number, y: number}|*}
	 * @private
	 */
	_getOffset(offsetMapName, source = false) {
		const key = source ? "source" : "target";

		const offset = {
			x: 0,
			y: 0,
		};

		let twister = this._twister;

		let nameOffsetMap = this._nameOffsetMap?.[this.data.name];

		if (nameOffsetMap) {
			twister = nameOffsetMap.twister;
		}

		// If the effect is missing, and it's not the source we're offsetting OR it is the source, but we don't have a target (it's playing on the spot)
		if (this.data.missed && (!source || !this.data.target)) {
			let missedOffset =
				this._offsetCache[key]?.missedOffset ||
				canvaslib.calculate_missed_position(this.source, this.target, twister);
			this._offsetCache[key].missedOffset = missedOffset;
			offset.x -= missedOffset.x;
			offset.y -= missedOffset.y;
		}

		const obj = source ? this.source : this.target;
		const multiplier = source
			? this.data.randomOffset?.source
			: this.data.randomOffset?.target;

		if (obj && multiplier) {
			let randomOffset =
				this._offsetCache[key]?.randomOffset ||
				canvaslib.get_random_offset(obj, multiplier, twister);
			this._offsetCache[key].randomOffset = randomOffset;
			offset.x -= randomOffset.x;
			offset.y -= randomOffset.y;
		}

		let extraOffset = this.data?.offset?.[key];
		if (extraOffset) {
			let newOffset = {
				x: extraOffset.x,
				y: extraOffset.y,
			};
			if (extraOffset.gridUnits) {
				newOffset.x *= canvas.grid.size;
				newOffset.y *= canvas.grid.size;
			}
			if (extraOffset.local) {
				if (
					!this._cachedSourceData?.position ||
					!this._cachedTargetData?.position
				) {
					this.getSourceData();
					this.getTargetData();
				}

				const startPos = this._cachedSourceData.position;
				const endPos = this._cachedTargetData.position;

				const angle = this.target
					? new Ray(startPos, endPos).angle
					: Ray.fromAngle(
						startPos.x,
						startPos.y,
						this._cachedSourceData.rotation,
						1
					).angle;

				newOffset = canvaslib.rotateAroundPoint(
					0,
					0,
					newOffset.x,
					newOffset.y,
					-angle
				);
			}
			offset.x -= newOffset.x;
			offset.y -= newOffset.y;
		}

		let offsetMap = this._nameOffsetMap?.[offsetMapName];

		if (!this._offsetCache[key]["nameCache"][offsetMapName]) {
			this._offsetCache[key]["nameCache"][offsetMapName] = {};
		}

		if (offsetMap) {
			if (offsetMap.missed) {
				const missedOffset =
					this._offsetCache[key]["nameCache"][offsetMapName]?.missedOffset ||
					canvaslib.calculate_missed_position(
						offsetMap.sourceObj,
						offsetMap.targetObj,
						offsetMap.twister
					);
				this._offsetCache[key]["nameCache"][offsetMapName].missedOffset =
					missedOffset;
				offset.x -= missedOffset.x;
				offset.y -= missedOffset.y;
			}

			const obj = offsetMap.targetObj || offsetMap.sourceObj;
			const multiplier =
				offsetMap.randomOffset?.source || offsetMap.randomOffset?.target;

			if (obj && multiplier) {
				let randomOffset =
					this._offsetCache[key]["nameCache"][offsetMapName]?.randomOffset ||
					canvaslib.get_random_offset(obj, multiplier, offsetMap.twister);
				this._offsetCache[key]["nameCache"][offsetMapName].randomOffset =
					randomOffset;
				offset.x -= randomOffset.x;
				offset.y -= randomOffset.y;
			}

			if (offsetMap.offset) {
				offset.x += offsetMap.offset.x;
				offset.y += offsetMap.offset.y;
			}
		}

		return offset;
	}

	/**
	 * Initializes the name offset map by establishing targets
	 *
	 * @param inOffsetMap
	 * @returns {{setup}|*}
	 * @private
	 */
	_setupOffsetMap(inOffsetMap) {
		if (!inOffsetMap.setup) {
			inOffsetMap.setup = true;
			inOffsetMap.sourceObj = inOffsetMap.source
				? this._validateObject(inOffsetMap.source)
				: false;
			inOffsetMap.targetObj = inOffsetMap.target
				? this._validateObject(inOffsetMap.target)
				: false;
			const repetition = this.data.repetition % inOffsetMap.repetitions;
			const seed = lib.get_hash(`${inOffsetMap.seed}-${repetition}`);
			inOffsetMap.twister = lib.createMersenneTwister(seed);
		}

		return inOffsetMap;
	}

	/**
	 * Plays the effect, returning two promises; one that resolves once the duration has been established, and another
	 * when the effect has finished playing
	 *
	 * @returns {Object}
	 */
	play() {
		const durationPromise = new Promise((resolve, reject) => {
			this._durationResolve = resolve;
		});

		const finishPromise = new Promise(async (resolve, reject) => {
			this._resolve = resolve;
			Hooks.callAll("createSequencerEffect", this);
			lib.debug(`Playing effect:`, this.data);
			this._initialize();
		});

		return {
			duration: durationPromise,
			promise: finishPromise,
		};
	}

	/**
	 *  Ends the effect
	 */
	endEffect() {
		if (this._ended) return;
		Hooks.callAll("endedSequencerEffect", this);
		this.destroy();
	}

	destroy(...args) {
		this._destroyDependencies();
		return super.destroy(...args);
	}

	/**
	 * Updates this effect with the given parameters
	 * @param inUpdates
	 * @returns {Promise}
	 */
	async update(inUpdates) {
		if (!this.userCanUpdate)
			throw lib.custom_error(
				"Sequencer",
				"CanvasEffect | Update | You do not have permission to update this effect"
			);
		CanvasEffect.validateUpdate(inUpdates);

		const newData = foundry.utils.deepClone(this.data);
		const updateKeys = Object.keys(inUpdates);

		updateKeys.forEach((key) => {
			foundry.utils.setProperty(newData, key, inUpdates[key]);
		});

		if (
			Object.keys(foundry.utils.diffObject(newData, this.data)).length === 0
		) {
			lib.debug(
				`Skipped updating effect with ID ${this.id} - no changes needed`
			);
			return;
		}

		if (this.data.persist) {
			const originalSourceUUID =
				lib.is_UUID(this.data.source) && this.data.attachTo
					? this.data.source
					: "Scene." + this.data.sceneId;

			const newSourceUUID =
				lib.is_UUID(newData.source) && newData.attachTo
					? newData.source
					: "Scene." + newData.sceneId;

			if (originalSourceUUID !== newSourceUUID) {
				flagManager.removeEffectFlags(originalSourceUUID, newData);
			}

			flagManager.addEffectFlags(newSourceUUID, newData);
		}

		lib.debug(`Updated effect with ID ${this.id}`);

		return sequencerSocket.executeForEveryone(
			SOCKET_HANDLERS.UPDATE_EFFECT,
			this.id,
			newData
		);
	}

	async addAnimatedProperties({ animations = [], loopingAnimation = [] } = {}) {
		const animationsToAdd = [];
		if (!Array.isArray(animations)) {
			throw lib.custom_error(
				this.data.moduleName,
				`animations must be an array of arrays`
			);
		}
		for (const animationData of animations) {
			if (!Array.isArray(animationData)) {
				throw lib.custom_error(
					this.data.moduleName,
					`each entry in animations must be an array, each with target, property name, and animation options`
				);
			}
			const result = canvaslib.validateAnimation(...animationData);
			if (typeof result === "string") {
				throw lib.custom_error(this.data.moduleName, result);
			}
			result.creationTimestamp = +new Date();
			animationsToAdd.push(result);
		}
		if (!Array.isArray(loopingAnimation)) {
			throw lib.custom_error(
				this.data.moduleName,
				`loopingAnimation must be an array of arrays`
			);
		}
		for (const animationData of loopingAnimation) {
			if (!Array.isArray(animationData)) {
				throw lib.custom_error(
					this.data.moduleName,
					`each entry in loopingAnimation must be an array, each with target, property name, and animation options`
				);
			}
			const result = canvaslib.validateLoopingAnimation(...animationData);
			if (typeof result === "string") {
				throw lib.custom_error(this.data.moduleName, result);
			}
			result.creationTimestamp = +new Date();
			animationsToAdd.push(result);
		}

		if (this.data.persist) {
			const originalSourceUUID =
				lib.is_UUID(this.data.source) && this.data.attachTo
					? this.data.source
					: "Scene." + this.data.sceneId;
			const newData = foundry.utils.deepClone(this.data);
			newData.animations = (newData.animations ?? []).concat(
				foundry.utils.deepClone(animationsToAdd)
			);
			flagManager.addEffectFlags(originalSourceUUID, newData);
		}

		return sequencerSocket.executeForEveryone(
			SOCKET_HANDLERS.ADD_EFFECT_ANIMATIONS,
			this.id,
			animationsToAdd
		);
	}

	async _addAnimations(inAnimations) {
		this._playAnimations(foundry.utils.deepClone(inAnimations));
		this.data.animations = (this.data.animations ?? []).concat(inAnimations);
	}

	/**
	 * Updates the effect
	 *
	 * @param inUpdates
	 * @returns {Promise}
	 * @private
	 */
	_update(inUpdates) {
		this.data = inUpdates;
		Hooks.callAll("updateSequencerEffect", this);
		this._destroyDependencies();
		return this._reinitialize();
	}

	/**
	 * Determines whether a position is within the bounds of this effect
	 *
	 * @param inPosition
	 * @returns {boolean}
	 */
	isPositionWithinBounds(inPosition) {
		if (!this.spriteContainer) return false;
		return canvaslib.is_position_within_bounds(
			inPosition,
			this.spriteContainer,
			this.parent
		);
	}

	/**
	 * Initializes the effect and places it on the canvas
	 *
	 * @returns {Promise}
	 * @private
	 */
	async _initialize() {
		this.ready = false;
		this._initializeVariables();
		this._addToContainer();
		this._createFile()
		this._updateCurrentFilePath(false, true)
		await this._createSprite();
		this._calculateDuration();
		this._createShapes();
		await this._setupMasks();
		await this._transformSprite();
		this._playPresetAnimations();
		this._playCustomAnimations();
		this._setEndTimeout();
		this._registerTickers()
		this._timeoutVisibility();
		await this._startEffect();
		this.ready = true;
	}

	/**
	 * Reinitializes the effect after it has been updated
	 *
	 * @param play
	 * @returns {Promise}
	 * @private
	 */
	async _reinitialize() {
		this.renderable = false;
		if (!this.shouldPlay) {
			return Sequencer.EffectManager._removeEffect(this);
		}
		this.actualCreationTime = +new Date();
		return this._initialize();
	}

	/**
	 * Initializes variables core to the function of the effect
	 * This is run as a part of the construction of the effect
	 *
	 * @private
	 */
	_initializeVariables() {
		// Responsible for rotating the sprite
		this.rotationContainer = this.addChild(new PIXI.Container());
		this.rotationContainer.id = this.id + "-rotationContainer";

		this.pluginContainer = PluginsManager.createSpriteContainers({ effect: this, container: this.rotationContainer });

		// An offset container for the sprite
		this.spriteContainer = this.pluginContainer.addChild(
			new PIXI.Container()
		);
		this.spriteContainer.id = this.id + "-spriteContainer";

		this._template = this.data.template;
		this._ended = null;
		this._maskContainer = null;
		this._maskSprite = null;
		this._file = null;
		this._loopOffset = 0;
		this.effectFilters = {};
		this._animationDuration = 0;
		this._animationTimes = {};
		this._twister = lib.createMersenneTwister(this.creationTimestamp);
		this._distanceCache = null;
		this._isRangeFind = false;
		this._customAngle = 0;
		this._currentFilePath = this.data.file;
		this._hooks = [];
		this._lastDimensions = {};
		this._lastScreenDimensions = {};

		if (this._resetTimeout) {
			clearTimeout(this._resetTimeout);
		}
		this._resetTimeout = null;

		this._source = false;
		this._target = false;
		this._offsetCache = {
			source: { nameCache: {} },
			target: { nameCache: {} },
		};

		this._nameOffsetMap = Object.fromEntries(
			Object.entries(
				foundry.utils.deepClone(this.data.nameOffsetMap ?? {})
			).map((entry) => {
				return [entry[0], this._setupOffsetMap(entry[1])];
			})
		);

		this.uuid = !lib.is_UUID(this.context.uuid)
			? this.id
			: this.context.uuid + ".data.flags.sequencer.effects." + this.id;

		this._ticker = CanvasAnimation.ticker;
		this._tickerMethods = [];
	}

	_addToTicker(func) {
		this._tickerMethods.push(func);
		this._ticker.add(func, this);
	}

	/**
	 * Destroys all dependencies to this element, such as tickers, animations, textures, and child elements
	 *
	 * @private
	 */
	_destroyDependencies() {
		if (this._ended) return;
		this._ended = true;

		this.mask = null;

		hooksManager.removeHooks(this.uuid);

		this._tickerMethods.forEach(func => this._ticker.remove(func, this));
		this._ticker = null;

		SequencerAnimationEngine.endAnimations(this.id);

		if (this._maskContainer) this._maskContainer.destroy({ children: true });
		if (this._maskSprite) {
			try {
				this._maskSprite.texture.destroy(true);
				this._maskSprite.destroy();
			} catch (err) {
			}
		}

		this.sprite.destroy();
		this.sprite = null;

		try {
			if (this.data.screenSpace) {
				SequencerAboveUILayer.removeContainerByEffect(this);
			}
		} catch (err) {
		}

		if (this.data.syncGroup) {
			SyncGroups.remove(this);
		}
		this.removeChildren().forEach((child) => child.destroy({ children: true }));
	}

	/**
	 * Plays preset animations
	 *
	 * @private
	 */
	_playPresetAnimations() {
		this._moveTowards();

		this._fadeOut();
		this._fadeIn();

		this._rotateOut();
		this._rotateIn();

		this._scaleOut();
		this._scaleIn();

		this._fadeOutAudio();
		this._fadeInAudio();
	}

	/**
	 * Gets an object based on an identifier, checking if it exists within the named offset map, whether it's a
	 * coordinate object, or if it's an UUID that needs to be fetched from the scene
	 *
	 * @param inIdentifier
	 * @param specific
	 * @param returnSource
	 * @returns {*}
	 * @private
	 */
	_getObjectByID(inIdentifier, specific = false, returnSource = false) {
		let source = inIdentifier;
		let offsetMap = this._nameOffsetMap?.[inIdentifier];
		if (offsetMap) {
			if(specific){
				source = (returnSource
					? offsetMap?.sourceObj || offsetMap?.targetObj
					: offsetMap?.targetObj || offsetMap?.sourceObj
				) || source;
			}else {
				source = offsetMap?.targetObj || offsetMap?.sourceObj || source;
			}
		} else {
			source = this._validateObject(source);
		}
		return source;
	}

	/**
	 * Validates the given parameter, whether it's a UUID or a coordinate object, and returns the proper one
	 *
	 * @param inObject
	 * @returns {*}
	 * @private
	 */
	_validateObject(inObject) {
		if (lib.is_UUID(inObject) || !canvaslib.is_object_canvas_data(inObject)) {
			inObject = lib.get_object_from_scene(inObject, this.data.sceneId);
			inObject = inObject?._object ?? inObject;
		}
		return inObject;
	}

	/**
	 * Adds this effect to the appropriate container on the right layer
	 *
	 * @private
	 */
	_addToContainer() {
		let layer;
		if (this.data.screenSpaceAboveUI) {
			layer = SequencerAboveUILayer;
		} else if (this.data.screenSpace) {
			layer = canvas.sequencerEffectsUILayer;
		} else if (this.data.aboveInterface) {
			layer = canvas.controls;
		} else if (this.data.aboveLighting) {
			layer = canvas.interface;
		} else {
			layer = canvas.primary;
		}

		layer.addChild(this);
		layer.sortChildren();
	}

	get startTimeMs() {
		return this._startTime * 1000;
	}

	get endTimeMs() {
		return this._endTime * 1000;
	}

	/**
	 * Calculates the duration of this effect, based on animation durations, the video source duration, end/start times, etc
	 *
	 * @private
	 */
	_calculateDuration() {
		let playbackRate = this.data.playbackRate || 1.0;

		this.mediaPlaybackRate = playbackRate;

		this._animationDuration = this.data.duration || this.mediaDurationMs;

		// If the effect moves, then infer the duration from the distance divided by the speed
		if (this.data.moveSpeed && this.data.moves) {
			let distance = canvaslib.distance_between(
				this.sourcePosition,
				this.targetPosition
			);
			let durationFromSpeed = (distance / this.data.moveSpeed) * 1000;
			this._animationDuration = Math.max(durationFromSpeed, this.data.duration);
		} else if (!this.data.duration && !this.hasAnimatedMedia) {
			// Determine static image duration
			let fadeDuration =
				(this.data.fadeIn?.duration ?? 0) + (this.data.fadeOut?.duration ?? 0);
			let scaleDuration =
				(this.data.scaleIn?.duration ?? 0) +
				(this.data.scaleOut?.duration ?? 0);
			let rotateDuration =
				(this.data.rotateIn?.duration ?? 0) +
				(this.data.rotateOut?.duration ?? 0);
			let moveDuration = 0;
			if (this.data.moves) {
				let distance = canvaslib.distance_between(
					this.sourcePosition,
					this.targetPosition
				);
				moveDuration =
					(this.data.moveSpeed
						? (distance / this.data.moveSpeed) * 1000
						: 1000) + this.data.moves.delay;
			}

			let animationDurations = this.data.animations?.length
				? Math.max(
					...this.data.animations.map((animation) => {
						if (animation.looping) {
							if (animation.loops === 0) return 0;
							return (
								(animation?.duration ?? 0) * (animation?.loops ?? 0) +
								(animation?.delay ?? 0)
							);
						} else {
							return (animation?.duration ?? 0) + (animation?.delay ?? 0);
						}
					})
				)
				: 0;

			this._animationDuration = Math.max(
				fadeDuration,
				scaleDuration,
				rotateDuration,
				moveDuration,
				animationDurations
			);

			this._animationDuration = this._animationDuration || 1000;
		}

		// Clamp effect duration to start time and end time
		this._startTime = 0;
		if (this.data.time?.start && this.mediaCurrentTime !== null) {
			let currentTime = !this.data.time.start.isPerc
				? this.data.time.start.value ?? 0
				: this._animationDuration * this.data.time.start.value;
			this.mediaCurrentTime = currentTime / 1000;
			this._startTime = currentTime / 1000;
		}

		this._endTime = this._animationDuration;
		if (this.data.time?.end) {
			if (this.data.time.end.isPerc) {
				this._endTime = this._animationDuration - (this._animationDuration * this.data.time.end.value);
			} else {
				this._endTime = this.data.time.isRange
					? this.data.time.end.value
					: this._animationDuration - this.data.time.end.value;
			}
		}
		this._endTime /= 1000;

		this._animationDuration = lib.clamp(this.endTimeMs - this.startTimeMs, 0, this._animationDuration);

		if (
			this._file?.markers &&
			this._startTime === 0 &&
			this._endTime === this.mediaDuration
		) {
			this._animationTimes.loopStart = this._file.markers.loop.start / playbackRate / 1000;
			this._animationTimes.loopEnd = this._file.markers.loop.end / playbackRate / 1000;
			this._animationTimes.forcedEnd = this._file.markers.forcedEnd / playbackRate / 1000;
		}

		this._totalDuration = this.loops
			? (this._animationDuration * this.loops) + (this.loopDelay * (this.loops - 1))
			: this._animationDuration;

		this._totalDuration /= playbackRate;

		if(this.data.persist){
			this.mediaLooping = (
				(!this.data.time || (this._startTime === 0 && this._endTime === this.mediaDuration)) &&
				this._animationTimes.loopStart === undefined &&
				this._animationTimes.loopEnd === undefined &&
				!this.loops &&
				!this.loopDelay
			);
		}else{
			this.mediaLooping = this._startTime === 0 && this._endTime > this.mediaDuration && !(this.loops && this.loopDelay);
		}

		// Resolve duration promise so that owner of effect may know when it is finished
		this._durationResolve(this._totalDuration);
	}

	/**
	 * If this effect is animatable, hold off on rendering it for a bit so that the animations have time to initialize to
	 * prevent it from spawning and then jumping to the right place
	 *
	 * @private
	 */
	_timeoutVisibility() {
		if(!this.data.animations){
			return this._setupHooks();
		}
		setTimeout(() => {
			this._setupHooks();
		},50);
	}

	/**
	 * Add Ticker handler to check for updates to attached objects
	 *
	 * @private
	 */
	_registerTickers() {
		//stretchTo && attached to stretchTo
		if (this.data.stretchTo && this.data.stretchTo?.attachTo) {
			this._addToTicker(this._transformStretchToAttachedSprite);
		}
		// attachTo, not attached to stretchTo
		if (this.data.attachTo?.active && !this.data.stretchTo?.attachTo) {
			this._addToTicker(this._transformAttachedNoStretchSprite);
		}

		// rotateTowards
		if (this.rotateTowards && this.data.rotateTowards?.attachTo) {
			this._addToTicker(this._transformRotateTowardsAttachedSprite);
		}

		// scaleTo
		if (this.data.scaleToObject && this.data?.attachTo?.active && this.data?.attachTo?.bindScale) {
			const { heightWidthRatio, widthHeightRatio, baseScaleX, baseScaleY } = this._getBaseScale()
			this._addToTicker(() => {
				this._applyScaleToObject(heightWidthRatio, widthHeightRatio, baseScaleX, baseScaleY);
				this._setAnchors()
			});
		}

		// source or target destroy safeguards
		if (this.isSourceTemporary) {
			this._addToTicker(this._checkSourceDestroyed);
		}
		if (this.isTargetTemporary) {
			this._addToTicker(this._checkTargetDestroyed);
		}
	}

	_checkSourceDestroyed() {
		if (this.isSourceDestroyed) {
			this._source = this.sourcePosition;
			SequencerEffectManager.endEffects({ effects: this });
		}
	}

	_checkTargetDestroyed() {
		if (this.isTargetDestroyed) {
			this._source = this.targetPosition;
			SequencerEffectManager.endEffects({ effects: this });
		}
	}

	_createFile() {
		if (this.data.file === "") {
			return;
		}

		let file
		if (this.data.customRange) {
			const template = this.template ? [this.template.gridSize, this.template.startPoint, this.template.endPoint] : [100, 0, 0]
			file = SequencerFileBase.make(
				this.data.file,
				"temporary.range.file",
				{template},
			);
		} else if (Sequencer.Database.entryExists(this.data.file)) {
			file = Sequencer.Database.getEntry(this.data.file).clone();
		} else {
			file = SequencerFileBase.make(this.data.file)
			this._currentFilePath = this.data.file;
		}

		if (file.template) {
			this._template =
				foundry.utils.mergeObject(
					{ gridSize: file.template[0], startPoint: file.template[1], endPoint: file.template[2] },
					this.data.template
				)

		}
		file.fileIndex = this.data.forcedIndex;
		file.twister = this._twister;
		this._file = file
		this._isRangeFind = file?.rangeFind;
	}

	_updateCurrentFilePath(distance, showDistanceWarning = false) {
		if (!this._file) {
			return;
		}
		if (!this.data.stretchTo) {
			this._currentFilePath = this._file.getFile();
			return;
		}
		distance = distance || (new Ray(this.sourcePosition, this.targetPosition)).distance;
		if (distance === 0 && showDistanceWarning) {
			lib.custom_error(
			      "effect",
			      `stretchTo - You are stretching over a distance of "0", you may be attempting to stretch between two of the same coordinates!`
			);
		}
		this._currentFilePath = this._file.getFileForDistance(distance);
	}

	/**
	 * Creates the sprite, and the relevant containers that manage the position and offsets of the overall visual look of the sprite
	 *
	 * @private
	 */
	async _createSprite() {
		this.renderable = false;
		const spriteData = {
			antialiasing: this.data?.fileOptions?.antialiasing,
			tiling: this.data.tilingTexture,
			xray: this.data.xray || this.data.screenSpace || this.data.screenSpaceAboveUI,
			isPersisted: this.data.persist && !this.data.loopOptions?.endOnLastLoop
		}
		/** @type {SequencerSpriteManager} */
		this.sprite = new SequencerSpriteManager(this._file, spriteData)
		this.spriteContainer.addChild(this.sprite)
		this.sprite.id = this.id + "-sprite";
		this.sprite.loopDelay = this.loopDelay
		this.sprite.currentTime = this._startTime
		this.sprite.loop = this.loops

		await this.sprite.activate(this._currentFilePath)

		this.sprite.volume = (this.data.volume ?? 0) * game.settings.get("core", "globalInterfaceVolume");

		if (this._isRangeFind && this.data.stretchTo && (this.data.attachTo?.active || this.data.stretchTo?.attachTo?.active)) {
			this.sprite.preloadVariants()
		}

		if (this.data.text) {
			const text = this.data.text.text;
			const fontSettings = foundry.utils.deepClone(this.data.text);
			fontSettings.fontSize = (fontSettings?.fontSize ?? 26) * (150 / canvas.grid.size);
			const textSprite = this.sprite.addText({text, textStyle: fontSettings})
			textSprite.zIndex = 1;
			const textAnchor = this.data.text.anchor
			textSprite.anchor.set(textAnchor?.x ?? 0.5, textAnchor?.y ?? 0.5);
		}

		this.sprite.filters = [];

		if (this.data.filters) {
			for (let index = 0; index < this.data.filters.length; index++) {
				const filterData = this.data.filters[index];
				const filter = new filters[filterData.className](filterData.data);
				filter.id = this.id + "-" + filterData.className + "-" + index.toString();
				if (filter instanceof PIXI.ColorMatrixFilter) {
					this.sprite.colorMatrixFilter = filter;
				} else {
					this.sprite.filters.push(filter);
				}
				const filterKeyName = filterData.name || filterData.className;
				this.effectFilters[filterKeyName] = filter;
			}
		}

		this.effectAlpha = this.data.opacity

		let spriteOffsetX = this.data.spriteOffset?.x ?? 0;
		let spriteOffsetY = this.data.spriteOffset?.y ?? 0;
		if (this.data.spriteOffset?.gridUnits) {
			spriteOffsetX *= canvas.grid.size;
			spriteOffsetY *= canvas.grid.size;
		}

		this.sprite.position.set(spriteOffsetX, spriteOffsetY);

		this.sprite.anchor?.set(
			this.data.spriteAnchor?.x ?? 0.5,
			this.data.spriteAnchor?.y ?? 0.5
		);

		let spriteRotation = this.data.spriteRotation ?? 0;
		if (this.data.randomSpriteRotation) {
			spriteRotation += lib.random_float_between(-360, 360, this._twister);
		}

		this.sprite.rotation = Math.normalizeRadians(
			Math.toRadians(spriteRotation)
		);

		this._customAngle = this.data.angle ?? 0;
		if (this.data.randomRotation) {
			this._customAngle += lib.random_float_between(-360, 360, this._twister);
		}

		const offsetMap = this._nameOffsetMap?.[this.data.source];
		if(offsetMap?.angle !== undefined) {
			this._customAngle += offsetMap?.angle;
		}
		if(offsetMap?.randomRotation) {
			this._customAngle += lib.random_float_between(-360, 360, offsetMap.twister);
		}

		this.spriteContainer.rotation = -Math.normalizeRadians(
			Math.toRadians(this._customAngle)
		);

		PluginsManager.createSprite({ effect: this });

		if (this.data.tint) {
			this.sprite.tint = this.data.tint;
		}

		// only set filter and fade effects when a faded version should actually be shown
		if (this.shouldShowFadedVersion) {
			this.alpha = game.settings.get(CONSTANTS.MODULE_NAME,"user-effect-opacity") / 100;
			this.filters = [
				new PIXI.ColorMatrixFilter({
					saturation: -1,
				}),
			];
		}

		this.updateElevation();
	}

	_createShapes() {
		const nonMaskShapes = (this.data?.shapes ?? []).filter(
			(shape) => !shape.isMask
		);
		this.shapes = {};
		for (const shape of nonMaskShapes) {
			const graphic = canvaslib.createShape(shape);
			graphic.filters = this.sprite.filters;
			this.spriteContainer.addChild(graphic);
			this.shapes[shape?.name ?? "shape-" + foundry.utils.randomID()] = graphic;
		}
	}

	updateElevation() {
		let targetElevation = Math.max(
				canvaslib.get_object_elevation(this.source ?? {}),
				canvaslib.get_object_elevation(this.target ?? {})
			);
		if(!CONSTANTS.IS_V12) targetElevation += 1;

		let effectElevation = this.data.elevation?.elevation ?? 0;
		if (!this.data.elevation?.absolute) {
			effectElevation += targetElevation;
		}
		this.elevation = effectElevation;
		let sort = !lib.is_real_number(this.data.zIndex)
			? (this?.parent?.children?.length ?? 0)
			: 100000;
		sort = PluginsManager.elevation({ effect: this, sort })
		sort += 100 + (this.data.aboveLighting ? 300 : 0);
		this.zIndex = sort + (lib.is_real_number(this.data.zIndex) ? this.data.zIndex : 0);
		this.sort = sort;
		this.sortLayer = this.data.sortLayer
		if (this.parent) {
			this.parent.sortChildren();
		}
	}

	updateTransform() {
		super.updateTransform();
		if (this.data.screenSpace || this.data.screenSpaceAboveUI) {
			const [screenWidth, screenHeight] = canvas.screenDimensions;

			if(this._lastScreenDimensions?.screenWidth !== screenWidth && this._lastScreenDimensions?.screenHeight !== screenHeight){
				this._lastScreenDimensions.screenWidth = screenWidth;
				this._lastScreenDimensions.screenHeight = screenHeight;
			}

			this.position.set(
				(this.data.screenSpacePosition?.x ?? 0) +
				screenWidth *
				(this.data.screenSpaceAnchor?.x ?? this.data.anchor?.x ?? 0.5),
				(this.data.screenSpacePosition?.y ?? 0) +
				screenHeight *
				(this.data.screenSpaceAnchor?.y ?? this.data.anchor?.y ?? 0.5)
			);

			if (this.data.screenSpaceScale) {
				const scaleData = this.data.screenSpaceScale ?? { x: 1, y: 1 };

				let scaleX = scaleData.x;
				let scaleY = scaleData.y;

				this._lastScreenDimensions.width = this.sprite.texture?.width || this._lastScreenDimensions.width || this.sprite.width || this.spriteContainer.children[this.spriteContainer.children.length-1].width;
				this._lastScreenDimensions.height = this.sprite.texture?.height || this._lastScreenDimensions.height || this.sprite.height || this.spriteContainer.children[this.spriteContainer.children.length-1].height;

				if (scaleData.fitX) {
					scaleX = scaleX * (screenWidth / this._lastScreenDimensions.width);
				}

				if (scaleData.fitY) {
					scaleY = scaleY * (screenHeight / this._lastScreenDimensions.height);
				}

				scaleX = scaleData.ratioX ? scaleY : scaleX;
				scaleY = scaleData.ratioY ? scaleX : scaleY;

				this.scale.set(scaleX, scaleY);
			}
		}
	}

	async _setupMasks() {
		const maskShapes = this.data.shapes.filter((shape) => shape.isMask);

		if (!this.data?.masks?.length && !maskShapes.length) return;

		const maskFilter = MaskFilter.create();

		for (const uuid of this.data.masks) {
			const documentObj = fromUuidSync(uuid);

			if (!documentObj || documentObj.parent.id !== this.data.sceneId) continue;

			const obj = documentObj.object;

			let shape = obj?.mesh;
			let shapeToAdd = shape;

			if (obj instanceof MeasuredTemplate || obj instanceof Drawing) {
				shape = obj?.shape?.geometry?.graphicsData?.[0]?.shape ?? obj?.shape;

				shape = PluginsManager.masking({
					effect: this,
					doc: documentObj,
					obj,
					shape
				});

				shapeToAdd = new PIXI.LegacyGraphics()
					.beginFill()
					.drawShape(shape)
					.endFill();

				if (obj instanceof MeasuredTemplate) {
					shapeToAdd.position.set(documentObj.x, documentObj.y);
				} else {
					const {
						x,
						y,
						shape: { width, height },
						rotation,
					} = documentObj;
					shapeToAdd.pivot.set(width / 2, height / 2);
					shapeToAdd.position.set(x + width / 2, y + height / 2);
					shapeToAdd.angle = rotation;
				}
				shapeToAdd.cullable = true;
				shapeToAdd.custom = true;
				shapeToAdd.renderable = false;
				shapeToAdd.uuid = uuid;
				canvas.stage.addChild(shapeToAdd);
			}
			shapeToAdd.obj = obj;

			const updateMethod = (doc) => {
				if (doc !== documentObj) return;
				const mask = maskFilter.masks.find((shape) => shape.uuid === uuid);
				if (!mask) return;
				if (!mask.custom) return;
				mask.clear();
				if (obj instanceof MeasuredTemplate) {
					mask.position.set(documentObj.x, documentObj.y);
					let maskObj = documentObj.object;
					shape = obj?.shape?.geometry?.graphicsData?.[0]?.shape ?? obj?.shape;
					shape = PluginsManager.masking({
						effect: this,
						doc: documentObj,
						obj: maskObj,
						shape
					});
				} else {
					const {
						x,
						y,
						shape: { width, height },
						rotation,
					} = documentObj;
					mask.pivot.set(width / 2, height / 2);
					mask.position.set(x + width / 2, y + height / 2);
					mask.angle = rotation;
				}
				mask.beginFill().drawShape(shape).endFill();
			};

			PluginsManager.maskingHooks.forEach(hook => {
				hooksManager.addHook(this.uuid, hook, (doc) => {
					setTimeout(() => {
						updateMethod(doc);
					}, 100);
				});
			});

			hooksManager.addHook(this.uuid, this.getHook("update", uuid), (doc) => {
				setTimeout(() => {
					updateMethod(doc);
				}, 100);
			});

			maskFilter.masks.push(shapeToAdd);
		}

		for (const shapeData of maskShapes) {
			const shape = canvaslib.createShape(shapeData);
			shape.cullable = true;
			shape.custom = true;
			shape.renderable = false;
			this.spriteContainer.addChild(shape);
			this.shapes[shapeData?.name ?? "shape-" + foundry.utils.randomID()] = shape;
			maskFilter.masks.push(shape);
		}

		this.sprite.filters.push(maskFilter);
	}

	/**
	 * Sets up the hooks relating to this effect's source and target
	 *
	 * @private
	 */
	_setupHooks() {

		const attachedToSource =
			this.data.attachTo?.active && lib.is_UUID(this.data.source);
		const attachedToTarget =
			(this.data.stretchTo?.attachTo || this.data.rotateTowards?.attachTo) &&
			lib.is_UUID(this.data.target);

		const baseRenderable = this.shouldPlayVisible;
		let renderable = baseRenderable;
		let alpha = null;

		if (attachedToSource) {
			hooksManager.addHook(this.uuid, this.getSourceHook("delete"), (doc) => {
				const uuid = doc.uuid;
				if (doc !== this.sourceDocument) return;
				this._source = this._cachedSourceData.position;
				SequencerEffectManager.objectDeleted(uuid);
			});

			if(this.isSourceDestroyed){
				SequencerEffectManager.objectDeleted(this.sourceDocument.uuid);
			}

			if (this.data.attachTo?.bindVisibility) {
				hooksManager.addHook(
					this.uuid,
					"sightRefresh",
					() => {
						const sourceVisible =
							this.source && (!this.sourceMesh?.occluded);
						const sourceHidden =
							this.sourceDocument && (this.sourceDocument?.hidden ?? false);
						const targetVisible =
							this.target &&
							(!attachedToTarget || (this.targetMesh?.occluded ?? true));
						this.renderable =
							baseRenderable &&
							(!sourceHidden || game.user.isGM) &&
							(sourceVisible || targetVisible) &&
							this._checkWallCollisions();
						this.alpha = sourceVisible && sourceHidden ? 0.5 : 1.0;
						renderable = baseRenderable && this.renderable;
					},
					true
				);
			}

			if (this.data.attachTo?.bindAlpha || this.data.attachTo?.bindElevation) {
				hooksManager.addHook(this.uuid, this.getSourceHook("update"), (doc) => {
					if (doc !== this.sourceDocument) return;
					if (this.data.attachTo?.bindAlpha) {
						this.spriteContainer.alpha = this.getSourceData().alpha;
					}
					if (this.data.attachTo?.bindElevation) {
						this.updateElevation();
					}
				});
			}

			if (this.data.attachTo?.bindAlpha) {
				alpha = this.getSourceData().alpha;
			}
		}

		if (attachedToTarget) {
			hooksManager.addHook(this.uuid, this.getTargetHook("delete"), (doc) => {
				if (doc !== this.target) return;
				this._target = this._cachedTargetData.position;
				const uuid = doc.uuid;
				SequencerEffectManager.objectDeleted(uuid);
			});
			if(this.isTargetDestroyed){
				SequencerEffectManager.objectDeleted(this.targetDocument.uuid);
			}
			hooksManager.addHook(this.uuid, this.getTargetHook("update"), (doc) => {
				if (doc !== this.target) return;
				this.updateElevation();
			});
		}

		for (let uuid of this.data?.tiedDocuments ?? []) {
			const tiedDocument = fromUuidSync(uuid);
			if (tiedDocument) {
				hooksManager.addHook(
					this.uuid,
					this.getHook("delete", tiedDocument.uuid),
					(doc) => {
						if (tiedDocument !== doc) return;
						SequencerEffectManager.objectDeleted(doc.uuid);
					}
				);
			}
		}

		setTimeout(() => {
			this.renderable = renderable;
			this.spriteContainer.alpha = alpha ?? 1.0;
		}, 25);
	}

	/**
	 * Calculates the padding and scale to stretch an effect across the given distance
	 *
	 * If the file is a SequencerFileBase instance, it will also pick the appropriate file for the right distance
	 *
	 * @param {number} distance
	 * @param {number} textureWidth
	 * @returns {Object}
	 * @private
	 */
	async _getDistanceScaling(distance, textureWidth) {
		if (!this._distanceCache || this._distanceCache?.distance !== distance) {
			let scaleX = 1.0;
			let scaleY = 1.0;

			if (this._file instanceof SequencerFileBase) {

				const startPoint = this.template?.startPoint ?? 0
				const endPoint = this.template?.endPoint ?? 0
				const widthWithPadding = textureWidth - (startPoint + endPoint);

				const spriteScale = distance / widthWithPadding

				scaleX = spriteScale;
				scaleY = this.data.stretchTo?.onlyX ? widthWithPadding / textureWidth : spriteScale;
			}

			this._distanceCache = {
				scaleX,
				scaleY,
				distance,
			};
		}

		return this._distanceCache;
	}

	/**
	 * Applies the distance scaling to the sprite based on the previous method
	 *
	 * @returns {Promise<void>}
	 * @private
	 */
	async _applyDistanceScaling() {
		const ray = new Ray(this.sourcePosition, this.targetPosition);

		this._rotateTowards(ray);

		const distance = ray.distance / (this.data.scale.x ?? 1.0);

		this._updateCurrentFilePath(distance)
		await this.sprite.activate(this._currentFilePath)
		const texture = this.sprite.texture

		let {  scaleX, scaleY } = await this._getDistanceScaling(distance, texture.width);

		if (this.data.attachTo?.active) {
			this.position.set(
				this.sourcePosition.x,
				this.sourcePosition.y
			);
		}

		if (this.data.tilingTexture) {
			const scaleX = (this.data.scale.x ?? 1.0);
			const scaleY = (this.data.scale.y ?? 1.0);
			this.sprite.scale.set(scaleX * this.flipX, scaleY * this.flipY);
			this.sprite.width = distance * scaleX;
			this.sprite.height = texture.height * scaleY;

			this.sprite.tileScale.x = this.data.tilingTexture.scale.x * scaleX;
			this.sprite.tileScale.y = this.data.tilingTexture.scale.y * scaleY;
			this.sprite.tilePosition = this.data.tilingTexture.position;
		} else {
			this.sprite.scale.set(
				scaleX * (this.data.scale.x ?? 1.0) * this.flipX,
				scaleY * (this.data.scale.y ?? 1.0) * this.flipY
			);
		}

	}

	_setAnchors() {
		let anchor = {x: 0.5, y: 0.5, ...(this.data.spriteAnchor ?? null)}

		if (
			(this.data.rotateTowards && this.data.rotateTowards.template) ||
			this.data.stretchTo
		) {
			const textureWidth = this.sprite.texture?.width ?? this.sprite.width;
			const templateAnchorX = this.template ? this.template.startPoint / textureWidth : undefined;
			anchor = { x: templateAnchorX, y: 0.5 }
		}
		if (this.data.rotateTowards && !this.data.rotateTowards.template && !this.data.anchor) {
			this.spriteContainer.pivot.set(this.sprite.width * -0.5,0);
		} else {
			this.spriteContainer.pivot.set(
				lib.interpolate(
					this.sprite.width * -0.5,
					this.sprite.width * 0.5,
					this.data.anchor?.x ?? 0.5
				),
				lib.interpolate(
					this.sprite.height * -0.5,
					this.sprite.height * 0.5,
					this.data.anchor?.y ?? 0.5
				)
			);
		}

		this.sprite.anchor?.set(
			this.flipX === 1 ? anchor.x : 1 - anchor.x,
			anchor.y
		);
	}

	_checkWallCollisions() {
		if (
			!this.data.stretchTo?.attachTo ||
			!this.data.stretchTo?.requiresLineOfSight
		)
			return true;

		const ray = new Ray(this.sourcePosition, this.targetPosition);

		const blockingObjects = canvas.walls.checkCollision(ray, { type: "sight" });

		if (!blockingObjects.length && !this.data.stretchTo?.hideLineOfSight) {
			SequencerEffectManager.endEffects({ effects: this });
		}

		return !blockingObjects.length;
	}

	/**
	 * Rotates the effect towards the target
	 *
	 * @param ray
	 * @private
	 */
	_rotateTowards(ray) {
		if (!ray) {
			const sourcePosition =
				this.flipX === 1 ? this.sourcePosition : this.targetPosition;
			const targetPosition =
				this.flipX === 1 ? this.targetPosition : this.sourcePosition;
			ray = new Ray(sourcePosition, targetPosition);
		}

		this.rotationContainer.rotation = Math.normalizeRadians(
			ray.angle + Math.toRadians(this.data.rotateTowards?.rotationOffset ?? 0)
		);

		PluginsManager.rotation({ effect: this });
	}

	/**
	 * Transforms the sprite, rotating it, stretching it, scaling it, sizing it according its data
	 *
	 * @private
	 */
	async _transformSprite() {
		if (this.data.stretchTo) {
			await this._applyDistanceScaling();
		}

		if (!this.data.stretchTo) {
			this._transformNoStretchSprite();
		}

		if (!this.data.screenSpace && (!this.data.attachTo?.active || this.data.stretchTo?.attachTo)) {
			this.position.set(this.sourcePosition.x, this.sourcePosition.y);
		}

		if (this.data.rotateTowards) {
			this._rotateTowards();
		}

		this._setAnchors()
		PluginsManager.rotation({ effect: this });
		this.sprite.updateDefaultScaling()
	}

	async _transformStretchToAttachedSprite() {
		try {
			await this._applyDistanceScaling();
			this._setAnchors()
		} catch (err) {
			//lib.debug_error(err);
		}
	}

	_transformNoStretchSprite() {
		if (this.data.tilingTexture) {
			this.sprite.tileScale = {
				x: this.data.tilingTexture.scale.x * this.gridSizeDifference,
				y: this.data.tilingTexture.scale.y * this.gridSizeDifference,
			};

			this.sprite.tilePosition = this.data.tilingTexture.position;
		}

		const { heightWidthRatio, widthHeightRatio, baseScaleX, baseScaleY } = this._getBaseScale()

		if (this.data.scaleToObject) {
			this._applyScaleToObject(heightWidthRatio, widthHeightRatio, baseScaleX, baseScaleY);

		} else if (this.data.size) {

			let { height, width } = this.data.size;

			if (this.data.size.width === "auto" || this.data.size.height === "auto") {
				height = this.sprite.height;
				width = this.sprite.width;

				if (this.data.size.width === "auto") {
					height = this.data.size.height;
					if (this.data.size.gridUnits) {
						height *= canvas.grid.size;
					}
					width = height * widthHeightRatio;
				} else if (this.data.size.height === "auto") {
					width = this.data.size.width;
					if (this.data.size.gridUnits) {
						width *= canvas.grid.size;
					}
					height = width * heightWidthRatio;
				}
			} else if (this.data.size.gridUnits) {
				height *= canvas.grid.size;
				width *= canvas.grid.size;
			}

			this.sprite.width = width * baseScaleX;
			this.sprite.height = height * baseScaleY;
		} else if (this.data.screenSpace) {
			this.sprite.scale.set(
				baseScaleX,
				baseScaleY
			);
		} else {
			this.sprite.scale.set(
				baseScaleX * this.gridSizeDifference,
				baseScaleY * this.gridSizeDifference
			);
		}
	}

	/**
	 * Calculate the base scale and aspect ratios of the sprite
	 *
	 * @returns {{heightWidthRatio: number, widthHeightRatio: number, baseScaleX: number, baseScaleY: number}}
	 *
	 * @private
	 */
	_getBaseScale() {
		const heightWidthRatio = this.sprite.height / this.sprite.width;
		const widthHeightRatio = this.sprite.width / this.sprite.height;

		const baseScaleX =
			(this.data.scale?.x ?? 1.0) *
			(this.data.spriteScale?.x ?? 1.0) *
			this.flipX;
		const baseScaleY =
			(this.data.scale?.y ?? 1.0) *
			(this.data.spriteScale?.y ?? 1.0) *
			this.flipY;

		return {
			heightWidthRatio,
			widthHeightRatio,
			baseScaleX,
			baseScaleY,
		}
	}

	_applyScaleToObject(heightWidthRatio, widthHeightRatio, baseScaleX, baseScaleY) {
		try {
			let { width, height } = this.getSourceData();

			if (this.sourceDocument instanceof TokenDocument) {
				width *= this.data.scaleToObject?.considerTokenScale
					? this.sourceDocument.texture.scaleX
					: 1.0;
				height *= this.data.scaleToObject?.considerTokenScale
					? this.sourceDocument.texture.scaleY
					: 1.0;
			}

			if (width === this._lastDimensions.width && height === this._lastDimensions.height) return;

			this._lastDimensions = { width, height };

			const ratioToUse = heightWidthRatio > widthHeightRatio;

			if (this.data.scaleToObject?.uniform) {
				let newWidth = Math.max(width, height);
				height = Math.max(width, height);
				width = newWidth;
			} else {
				width = width * (ratioToUse ? widthHeightRatio : 1.0);
				height = height * (!ratioToUse ? heightWidthRatio : 1.0);
			}

			this.sprite.width = width * (this.data.scaleToObject?.scale ?? 1.0) * baseScaleX;
			this.sprite.height = height * (this.data.scaleToObject?.scale ?? 1.0) * baseScaleY;

			SequencerAnimationEngine.updateStartValues(this.sprite, "width");
			SequencerAnimationEngine.updateStartValues(this.sprite, "height");
			SequencerAnimationEngine.updateStartValues(this.sprite, "scale.x");
			SequencerAnimationEngine.updateStartValues(this.sprite, "scale.y");

		} catch (err) {

		}

	}

	async _transformAttachedNoStretchSprite() {

		if (this.isDestroyed) return;

		const applyRotation =
			this.data.attachTo?.bindRotation &&
			!(
				this.sourceDocument instanceof TokenDocument &&
				this.sourceDocument.lockRotation
			) &&
			(this.sourceDocument?.rotation !== undefined ||
				this.sourceDocument?.direction !== undefined) &&
			!this.data.rotateTowards &&
			!this.data.stretchTo;

		if (applyRotation) {
			this.rotationContainer.rotation = this.getSourceData().rotation;
		}

		PluginsManager.rotation({ effect: this });

		this.position.set(
			this.sourcePosition.x,
			this.sourcePosition.y
		);
	}

	async _transformRotateTowardsAttachedSprite() {
		if (this.isDestroyed) return;
		try {
			this._rotateTowards();
			this._setAnchors()
		} catch (err) {
			lib.debug_error(err);
		}
	}

	/**
	 * Provided an animation targeting the rotation of the sprite's primary container, this method will counter-rotate
	 * the sprite in an equal fashion so that the sprite's rotation remains static relative to this animation
	 *
	 * @param animation
	 * @returns {*[]}
	 * @private
	 */
	_counterAnimateRotation(animation) {
		if (
			animation.target === this.spriteContainer &&
			this.data.zeroSpriteRotation
		) {
			delete animation.target;
			let counterAnimation = foundry.utils.deepClone(animation);
			animation.target = this.spriteContainer;
			counterAnimation.target = this.sprite;
			if (counterAnimation.values) {
				counterAnimation.values = counterAnimation.values.map(
					(value) => value * -1
				);
			} else {
				counterAnimation.from *= -1;
				counterAnimation.to *= -1;
			}
			if (!Array.isArray(animation)) {
				animation = [animation, counterAnimation];
			} else {
				animation.push(counterAnimation);
			}
		}

		return animation;
	}

	/**
	 * Plays the custom animations of this effect
	 *
	 * @returns {number}
	 * @private
	 */
	_playCustomAnimations() {
		if (!this.data.animations) return 0;

		this._playAnimations(
			foundry.utils.deepClone(this.data.animations) ?? [],
			this.actualCreationTime - this.creationTimestamp
		);
	}

	_playAnimations(animations, timeDifference = 0) {
		let animationsToSend = [];

		const oneShotAnimations = animations.filter(
			(animation) => !animation.looping && !animation.fromEnd
		);

		for (let animation of oneShotAnimations) {
			if (animation.target === 'alphaFilter') {
				animation.target = this
				animation.propertyName = 'effectAlpha'
			} else if (animation.target === "effect") {
				animation.target = this;
			} else {
				animation.target = foundry.utils.getProperty(this, animation.target);
			}

			if (!animation.target) continue;

			if (animation.propertyName.indexOf("rotation") > -1) {
				animation.from = animation.from * (Math.PI / 180);
				animation.to = animation.to * (Math.PI / 180);
			}

			if (
				["position.x", "position.y", "height", "width"].includes(
					animation.propertyName
				) &&
				animation.gridUnits
			) {
				animation.from *= canvas.grid.size;
				animation.to *= canvas.grid.size;
			}

			if (
				["position.x", "position.y", "height", "width"].includes(
					animation.propertyName
				) &&
				animation.screenSpace
			) {
				const [screenWidth, screenHeight] = canvas.screenDimensions;
				const dimension = animation.propertyName === "position.x" || animation.propertyName === "width"
					? screenWidth
					: screenHeight;
				animation.from *= dimension;
				animation.to *= dimension;
			}

			if (["hue"].includes(animation.propertyName)) {
				animation.getPropertyName = "values." + animation.propertyName;
			}

			animationsToSend = animationsToSend.concat(
				this._counterAnimateRotation(animation)
			);
		}

		const loopingAnimations = animations.filter(
			(animation) => animation.looping
		);

		for (let animation of loopingAnimations) {
			if (animation.target === 'alphaFilter') {
				animation.target = this
				animation.propertyName = 'effectAlpha'
			} else if (animation.target === "effect") {
				animation.target = this;
			} else {
				animation.target = foundry.utils.getProperty(this, animation.target);
			}

			if (!animation.target) continue;

			if (animation.propertyName.indexOf("rotation") > -1) {
				animation.values = animation.values.map((angle) => {
					return angle * (Math.PI / 180);
				});
			}

			if (
				["position.x", "position.y", "height", "width"].includes(
					animation.propertyName
				) &&
				animation.gridUnits
			) {
				animation.values = animation.values.map((value) => {
					return value * canvas.grid.size;
				});
			}

			if (["hue"].includes(animation.propertyName)) {
				animation.getPropertyName = "values." + animation.propertyName;
			}

			animationsToSend = animationsToSend.concat(
				this._counterAnimateRotation(animation)
			);
		}

		if (!(this instanceof PersistentCanvasEffect)) {
			animationsToSend = animationsToSend.concat(
				this._getFromEndCustomAnimations()
			);
		}

		setTimeout(() => {
			SequencerAnimationEngine.addAnimation(
				this.id,
				animationsToSend,
				timeDifference
			);
		}, 20);
	}

	_getFromEndCustomAnimations(immediate = false) {
		let fromEndAnimations = [];

		const animations = foundry.utils.deepClone(this.data.animations) ?? [];

		const oneShotEndingAnimations = animations.filter(
			(animation) => !animation.looping && animation.fromEnd
		);

		for (let animation of oneShotEndingAnimations) {
			animation.target = foundry.utils.getProperty(this, animation.target);

			if (!animation.target) continue;

			animation.delay = lib.is_real_number(immediate)
				? Math.max(immediate - animation.duration + animation.delay, 0)
				: Math.max(
					this._totalDuration - animation.duration + animation.delay,
					0
				);

			if (animation.propertyName.indexOf("rotation") > -1) {
				animation.from = animation.from * (Math.PI / 180);
				animation.to = animation.to * (Math.PI / 180);
			}

			if (
				["position.x", "position.y", "height", "width"].includes(
					animation.propertyName
				) &&
				animation.gridUnits
			) {
				animation.from *= canvas.grid.size;
				animation.to *= canvas.grid.size;
			}

			fromEndAnimations = fromEndAnimations.concat(
				this._counterAnimateRotation(animation)
			);
		}

		return fromEndAnimations;
	}

	/**
	 * Fades in the effect at the start of the effect
	 *
	 * @returns {number|*}
	 * @private
	 */
	_fadeIn() {
		if (!this.data.fadeIn || !this.sprite) return 0;

		let fadeIn = this.data.fadeIn;

		if (
			this.actualCreationTime -
			(this.creationTimestamp + fadeIn.duration + fadeIn.delay) >
			0
		) {
			return;
		}

		this.effectAlpha = 0.0;

		SequencerAnimationEngine.addAnimation(this.id, {
			target: this,
			propertyName: "effectAlpha",
			to: this.data.opacity,
			duration: fadeIn.duration,
			ease: fadeIn.ease,
			delay: fadeIn.delay,
			absolute: true,
		});

		return fadeIn.duration + fadeIn.delay;
	}

	/**
	 * Fades in the effect's audio at the start of the effect
	 *
	 * @returns {number|*}
	 * @private
	 */
	_fadeInAudio() {
		if (!this.data.fadeInAudio || !this.sprite || !this.sprite.hasAnimatedMedia) return 0;

		let fadeInAudio = this.data.fadeInAudio;

		if (
			this.actualCreationTime -
			(this.creationTimestamp +
				fadeInAudio.duration +
				fadeInAudio.delay) >
			0
		)
			return;

		this.sprite.volume = 0.0;

		SequencerAnimationEngine.addAnimation(this.id, {
			target: this.sprite,
			propertyName: "volume",
			to:
				(this.data.volume ?? 0) *
				game.settings.get("core", "globalInterfaceVolume"),
			duration: fadeInAudio.duration,
			ease: fadeInAudio.ease,
			delay: fadeInAudio.delay,
			absolute: true,
		});

		return fadeInAudio.duration + fadeInAudio.delay;
	}

	/**
	 * Fades out the effect at the end of the effect's duration
	 *
	 * @returns {number|*}
	 * @private
	 */
	_fadeOut(immediate = false) {
		if (!this.data.fadeOut || !this.sprite) return 0;

		let fadeOut = this.data.fadeOut;

		fadeOut.delay = lib.is_real_number(immediate)
			? Math.max(immediate - fadeOut.duration + fadeOut.delay, 0)
			: Math.max(this._totalDuration - fadeOut.duration + fadeOut.delay, 0);

		SequencerAnimationEngine.addAnimation(this.id, {
			target: this,
			propertyName: "effectAlpha",
			to: 0.0,
			duration: fadeOut.duration,
			ease: fadeOut.ease,
			delay: fadeOut.delay,
			absolute: true,
		});

		return fadeOut.duration + fadeOut.delay;
	}

	/**
	 * Fades out the effect at the end of the effect's duration
	 *
	 * @returns {number|*}
	 * @private
	 */
	_fadeOutAudio(immediate = false) {
		if (!this.data.fadeOutAudio || !this.sprite || !this.sprite.hasAnimatedMedia) return 0;

		let fadeOutAudio = this.data.fadeOutAudio;

		fadeOutAudio.delay = lib.is_real_number(immediate)
			? Math.max(immediate - fadeOutAudio.duration + fadeOutAudio.delay, 0)
			: Math.max(
				this._totalDuration - fadeOutAudio.duration + fadeOutAudio.delay,
				0
			);

		setTimeout(() => {
			SequencerAnimationEngine.addAnimation(this.id, {
				target: this.sprite,
				propertyName: "volume",
				to: 0.0,
				duration: fadeOutAudio.duration,
				ease: fadeOutAudio.ease,
				delay: fadeOutAudio.delay,
				absolute: true,
			});
		});

		return fadeOutAudio.duration + fadeOutAudio.delay;
	}

	/**
	 * Determines the scale to animate from or to
	 * @param property
	 * @returns {{x: number, y: number}}
	 * @private
	 */
	_determineScale(property) {
		let scale = {
			x: this.sprite.scale.x,
			y: this.sprite.scale.y,
		};

		if (lib.is_real_number(property.value)) {
			scale.x *= property.value * this.gridSizeDifference * this.flipX;
			scale.y *= property.value * this.gridSizeDifference * this.flipY;
		} else {
			scale.x *= property.value.x * this.gridSizeDifference * this.flipX;
			scale.y *= property.value.y * this.gridSizeDifference * this.flipY;
		}

		return scale;
	}

	/**
	 * Scales the effect in at the start of the effect
	 *
	 * @returns {number|*}
	 * @private
	 */
	_scaleIn() {
		if (!this.data.scaleIn || !this.sprite) return 0;

		let scaleIn = this.data.scaleIn;
		let fromScale = this._determineScale(scaleIn);

		if (
			this.actualCreationTime -
			(this.creationTimestamp + scaleIn.duration + scaleIn.delay) >
			0
		)
			return;

		let toScale = {
			x: this.sprite.scale.x,
			y: this.sprite.scale.y,
		};

		this.sprite.scale.set(fromScale.x, fromScale.y);

		SequencerAnimationEngine.addAnimation(this.id, [
			{
				target: this.sprite,
				propertyName: "scale.x",
				from: fromScale.x,
				to: toScale.x,
				duration: scaleIn.duration,
				ease: scaleIn.ease,
				delay: scaleIn.delay,
				absolute: true,
			},
			{
				target: this.sprite,
				propertyName: "scale.y",
				from: fromScale.y,
				to: toScale.y,
				duration: scaleIn.duration,
				ease: scaleIn.ease,
				delay: scaleIn.delay,
				absolute: true,
			},
		]);

		return scaleIn.duration + scaleIn.delay;
	}

	/**
	 * Scales the effect out at the end of the effect's duration
	 *
	 * @returns {number|*}
	 * @private
	 */
	_scaleOut(immediate = false) {
		if (!this.data.scaleOut || !this.sprite) return 0;

		let scaleOut = this.data.scaleOut;
		let scale = this._determineScale(scaleOut);

		scaleOut.delay = lib.is_real_number(immediate)
			? Math.max(immediate - scaleOut.duration + scaleOut.delay, 0)
			: Math.max(
				this._totalDuration - scaleOut.duration + scaleOut.delay,
				0
			);

		SequencerAnimationEngine.addAnimation(this.id, [
			{
				target: this.sprite,
				propertyName: "scale.x",
				to: scale.x,
				duration: scaleOut.duration,
				ease: scaleOut.ease,
				delay: scaleOut.delay,
				absolute: true,
			},
			{
				target: this.sprite,
				propertyName: "scale.y",
				to: scale.y,
				duration: scaleOut.duration,
				ease: scaleOut.ease,
				delay: scaleOut.delay,
				absolute: true,
			},
		]);

		return scaleOut.duration + scaleOut.delay;
	}

	/**
	 * Rotates the effect in at the start of the effect
	 *
	 * @returns {number|*}
	 * @private
	 */
	_rotateIn() {
		if (!this.data.rotateIn || !this.sprite) return 0;

		let rotateIn = this.data.rotateIn;

		if (
			this.actualCreationTime -
			(this.creationTimestamp + rotateIn.duration + rotateIn.delay) >
			0
		)
			return;

		let original_radians = this.spriteContainer.rotation;
		this.spriteContainer.rotation = rotateIn.value * (Math.PI / 180);

		SequencerAnimationEngine.addAnimation(
			this.id,
			this._counterAnimateRotation({
				target: this.spriteContainer,
				propertyName: "rotation",
				to: original_radians,
				duration: rotateIn.duration,
				ease: rotateIn.ease,
				delay: rotateIn.delay,
				absolute: true,
			})
		);

		return rotateIn.duration + rotateIn.delay;
	}

	/**
	 * Rotates the effect out at the end of the effect's duration
	 *
	 * @returns {number|*}
	 * @private
	 */
	_rotateOut(immediate = false) {
		if (!this.data.rotateOut || !this.sprite) return 0;

		let rotateOut = this.data.rotateOut;

		rotateOut.delay = lib.is_real_number(immediate)
			? Math.max(immediate - rotateOut.duration + rotateOut.delay, 0)
			: Math.max(
				this._totalDuration - rotateOut.duration + rotateOut.delay,
				0
			);

		SequencerAnimationEngine.addAnimation(
			this.id,
			this._counterAnimateRotation({
				target: this.spriteContainer,
				propertyName: "rotation",
				to: rotateOut.value * (Math.PI / 180),
				duration: rotateOut.duration,
				ease: rotateOut.ease,
				delay: rotateOut.delay,
				absolute: true,
			})
		);

		return rotateOut.duration + rotateOut.delay;
	}

	/**
	 * Causes the effect to move towards the given location
	 *
	 * @returns {number|*}
	 * @private
	 */
	_moveTowards() {
		if (!this.data.moves || !this.sprite) return 0;

		let moves = this.data.moves;

		let movementDuration = this._totalDuration;
		if (this.data.moveSpeed) {
			const distance = canvaslib.distance_between(
				this.sourcePosition,
				this.targetPosition
			);
			movementDuration = (distance / this.data.moveSpeed) * 1000;
		}

		if (this.data.moves.rotate) this._rotateTowards();

		const duration = movementDuration - moves.delay;

		if (
			this.actualCreationTime -
			(this.creationTimestamp + duration + moves.delay) >
			0
		)
			return;

		SequencerAnimationEngine.addAnimation(this.id, [
			{
				target: this,
				propertyName: "position.x",
				to: this.targetPosition.x,
				duration: duration,
				ease: moves.ease,
				delay: moves.delay,
				absolute: true
			},
			{
				target: this,
				propertyName: "position.y",
				to: this.targetPosition.y,
				duration: duration,
				ease: moves.ease,
				delay: moves.delay,
				absolute: true
			},
		]);

		return duration + moves.delay;
	}

	/**
	 * If this effect is temporary, this sets the timeout for when the effect should resolve and get removed;
	 *
	 * @private
	 */
	_setEndTimeout() {
		setTimeout(() => {
			this._resolve(this.data);
			this.endEffect();
		}, this._totalDuration);
	}

	_setupTimestampHook(offset) {
		if (!this._file?.originalMetadata?.timestamps || this._ended) return;
		const timestamps = this._file.getTimestamps();
		const timestampArray = Array.isArray(timestamps)
			? timestamps
			: [timestamps];
		for (const timestamp of timestampArray) {
			if (!lib.is_real_number(timestamp)) continue;
			let realTimestamp = timestamp - offset / this.mediaPlaybackRate;
			if (realTimestamp < 0) {
				realTimestamp += this._endTime;
			}
			setTimeout(() => {
				if (this._ended) return;
				Hooks.callAll("sequencerEffectTimestamp", this, this._file);
				if (this.mediaLooping) {
					const offsets = (this._endTime - this.mediaCurrentTime) * -1000;
					this._setupTimestampHook(offsets);
				}
			}, realTimestamp);
		}
	}

	/**
	 * Starts the loop of this effect, calculating the difference between the effect's creation time, and the actual
	 * creation time on the client
	 *
	 * @returns {Promise<void>}
	 * @private
	 */
	async _startEffect() {

		if (!this.hasAnimatedMedia) return;

		let creationTimeDifference = this.data.persist ? this.actualCreationTime - this.creationTimestamp : 0;
		creationTimeDifference *= this.mediaPlaybackRate

		// +1 because "loops: 1" means we run the animation one time, not that it restarts once
		// whereas 0 means endless looping.
		this._currentLoops = Math.floor(creationTimeDifference / this._totalDuration) + 1;

		if (this.loops && this._currentLoops > this.loops) {
			if(this.data.loopOptions?.endOnLastLoop || !this.data.persist) {
				return this.endEffect();
			}
			await this.pauseMedia();
			this.mediaCurrentTime = this._endTime;
			if (this.sprite.texture) {
				const oldRenderable = this.renderable;
				this.renderable = false;
				setTimeout(() => {
					this.updateTexture();
					setTimeout(() => {
						this.renderable ||= oldRenderable;
					}, 150)
				}, 150);
			}
			return;
		}

		return this._startLoop(creationTimeDifference);
	}

	/**
	 * Kicks off the loop, or just sets the video to loop
	 *
	 * @param creationTimeDifference
	 * @returns {Promise<void>}
	 * @private
	 */
	async _startLoop(creationTimeDifference) {
		if (!this._animationTimes.loopStart) {
			this._loopOffset =
				(creationTimeDifference % this._animationDuration) / 1000;
		} else if ((creationTimeDifference / 1000) > this._animationTimes.loopStart) {
			const loopDuration =
				this._animationTimes.loopEnd - this._animationTimes.loopStart;
			this._loopOffset =
				(creationTimeDifference % (loopDuration * 1000)) / 1000;
		}

		if (this._loopOffset) {
			this.mediaCurrentTime = this._loopOffset
		}
		await this.playMedia();
		this._addToTicker(this.loopHandler);
	}

	async loopHandler() {
		if (this._ended || this._isEnding) {
			return;
		}
		const endTime = this.data.persist ? (this._animationTimes.loopEnd ?? this._endTime) : this._endTime;
		if (this.mediaCurrentTime < endTime) {
			return;
		}
		if (this.restartLoopHandler != null) {
			return;
		}

		// if we're above end time, we can safely just pause for now
		this.pauseMedia();

		// default media current time to exactly end time so we don't
		// continue to trigger certain parts of the following code
		// unnecessarily
		this.mediaCurrentTime = this._endTime;

		// if we reached maximum loops, stay paused or even end the effect
		if ((this.loops || !this.data.persist) && this._currentLoops >= this.loops) {
			if (!this.data.persist || (this.data.persist && this.data.loopOptions?.endOnLastLoop)) {
				this.endEffect();
			}
			this._ticker?.remove(this.loopHandler, this);
			return;
		}

		const restartTime = this._startTime === 0 && this._animationTimes.loopStart 
		  ? this._animationTimes.loopStart 
			: this._startTime;
		// no loop delay means just start again at the beginning!
		if (!this.loopDelay) {
			this._currentLoops++;
			this.mediaCurrentTime = restartTime;
			this.playMedia();
			return;
		}

		this._currentLoops++;
		// register restart handler to trigger after loop delay
		this.restartLoopHandler = setTimeout(() => {
			this.restartLoopHandler = null;
			this.mediaCurrentTime = restartTime;
			this.playMedia();
		}, this.loopDelay)
	}
}

class PersistentCanvasEffect extends CanvasEffect {

	/** @OVERRIDE */
	_playPresetAnimations() {
		this._moveTowards();
		this._fadeIn();
		this._scaleIn();
		this._rotateIn();
	}

	/** @OVERRIDE */
	_timeoutVisibility() {
		let creationTimeDifference = this.actualCreationTime - this.creationTimestamp;
		let timeout =
			creationTimeDifference === 0 && !this.data.animations ? 0 : 50;
		setTimeout(() => {
			this._setupHooks();
		}, timeout);
	}

	/** @OVERRIDE */
	_setEndTimeout() {
		let creationTimeDifference = this.actualCreationTime - this.creationTimestamp;
		if(this.loops && creationTimeDifference >= this._totalDuration && this.hasAnimatedMedia){
			setTimeout(() => {
				this.pauseMedia();
			}, this._totalDuration);
		}
	}

	/** @OVERRIDE */
	async endEffect() {
		if (this._isEnding) return;
		this._isEnding = true;
		let extraEndDuration = this.data.extraEndDuration ?? 0;
		this.mediaLooping = false;
		if (this._animationTimes?.forcedEnd) {
			this.mediaCurrentTime = this._animationTimes.forcedEnd;
			extraEndDuration += (this.mediaDuration - (this._animationTimes?.forcedEnd ?? 0)) * 1000;
		} else if (this._animationTimes?.loopEnd) {
			extraEndDuration += (this.mediaDuration - this.mediaCurrentTime) * 1000;
		}
		const fromEndCustomAnimations = this._getFromEndCustomAnimations(extraEndDuration);
		const durations = [
			this._fadeOut(extraEndDuration),
			this._fadeOutAudio(extraEndDuration),
			this._scaleOut(extraEndDuration),
			this._rotateOut(extraEndDuration),
			extraEndDuration,
			...fromEndCustomAnimations.map(
				(animation) => animation.duration + animation.delay
			),
		].filter(Boolean);
		SequencerAnimationEngine.addAnimation(this.id, fromEndCustomAnimations);
		const waitDuration = Math.max(...durations, 0);
		this._resolve(waitDuration);
		return new Promise((resolve) =>
			setTimeout(() => {
				super.endEffect();
				resolve(this.data);
			}, waitDuration)
		);
	}
}
