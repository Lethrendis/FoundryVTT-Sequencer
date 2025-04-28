import * as lib from "../lib/lib.js";
import Section from "./section.js";
import CrosshairsDocument from "../modules/sequencer-crosshair/CrosshairsDocument.js";
import traits from "./traits/_traits.js";
import CONSTANTS from "../constants.js";

export default class CrosshairSection extends Section {
	constructor(inSequence, inName = "") {
		super(inSequence);
		this._name = inName;
		this._type = CONST.MEASURED_TEMPLATE_TYPES.CIRCLE;
		this._distance = canvas.grid.distance/2;
		this._angle = 53.13;
		this._width = canvas.grid.distance;
		this._direction = 0;
		this._borderAlpha = 0.75;
		this._borderColor = null;
		this._fillColor = null;
		this._textureAlpha = undefined;
		this._persist = false;
		this._config = CrosshairsDocument.defaultConfig;
		this._waitUntilFinished = true;
		this._callbacks = {};
	}

	static niceName = "Crosshair";

	/**
	 * Sets the type of MeasurableTemplate to create, see CONST.MEASURED_TEMPLATE_TYPES
	 */
	type(inType = "") {
		if (typeof inType !== "string"){
			throw this.sequence._customError(this, "type", "inType must be of type string");
		}
		if (!Object.values(CONST.MEASURED_TEMPLATE_TYPES).includes(inType)){
			throw this.sequence._customError(this, "type", `inType must be one of valid types: ${Object.values(CONST.MEASURED_TEMPLATE_TYPES).join(" ")} (see CONST.MEASURED_TEMPLATE_TYPES)`,);
		}
		this._type = inType;
		return this;
	}

	/**
	 * Sets a custom label to be set as a part of this crosshair
	 */
	label(inText, inOptions = {}) {
		if (typeof inOptions !== "object"){
			throw this.sequence._customError(this, "label", "inOptions must be of type object");
		}
		inOptions = foundry.utils.mergeObject({
			dx: CrosshairsDocument.defaultConfig.label.dx, dy: CrosshairsDocument.defaultConfig.label.dy
		}, inOptions,);
		if (typeof inText !== "string"){
			throw this.sequence._customError(this, "label", "inText must be of type string");
		}
		if (!lib.is_real_number(inOptions.dx)){
			throw this.sequence._customError(this, "label", "inOptions.dx must be of type number");
		}
		if (!lib.is_real_number(inOptions.dy)){
			throw this.sequence._customError(this, "label", "inOptions.dy must be of type number");
		}
		this._config["label"]["text"] = inText;
		this._config["label"]["dx"] = inOptions.dx;
		this._config["label"]["dy"] = inOptions.dy;
		return this;
	}

	/**
	 * Sets how the position of the crosshair should snap on the grid
	 */
	snapPosition(inSnap) {
		if (!lib.is_real_number(inSnap)){
			throw this.sequence._customError(this, "snapPosition", "inSnap must be of type number, see CONST.GRID_SNAPPING_MODES");
		}
		this._config["snap"]["position"] = inSnap;
		return this;
	}

	/**
	 * Sets the distance for the crosshair - or radius for a circular crosshair
	 */
	distance(inDistance, inOptions = {}) {
		if (typeof inOptions !== "object"){
			throw this.sequence._customError(this, "distance", "inOptions must be of type object");
		}
		inOptions = foundry.utils.mergeObject({
			min: CrosshairsDocument.defaultConfig.distanceMin, max: CrosshairsDocument.defaultConfig.distanceMax
		}, inOptions,);
		if (!lib.is_real_number(inDistance)){
			throw this.sequence._customError(this, "distance", "inDistance must be of type number");
		}
		if (inOptions.min !== null) {
			if (!lib.is_real_number(inOptions.min)){
				throw this.sequence._customError(this, "distance", "inOptions.min must be of type number");
			}
			if (inOptions.min <= 0){
				throw this.sequence._customError(this, "distance", "inOptions.min must be a non-zero number");
			}
		} else {
			inOptions.min = inDistance;
		}
		if (inOptions.max !== null) {
			if (!lib.is_real_number(inOptions.max)){
				throw this.sequence._customError(this, "distance", "inOptions.max must be of type number");
			}
			if (inOptions.max <= 0){
				throw this.sequence._customError(this, "distance", "inOptions.max must be a non-zero number");
			}
		} else {
			inOptions.max = inDistance;
		}

		if (inOptions.min > inOptions.max){
			throw this.sequence._customError(this, "distance", "inOptions.min cannot be larger than inOptions.max");
		}

		this._distance = inDistance;
		this._config["distanceMin"] = inOptions.min;
		this._config["distanceMax"] = inOptions.max;
		return this;
	}

	/**
	 * Configures the angle of the crosshair - mostly used for the width of cone crosshairs
	 */
	angle(inAngle) {
		if (!lib.is_real_number(inAngle)){
			throw this.sequence._customError(this, "angle", "inAngle must be of type number");
		}
		this._angle = inAngle;
		return this;
	}

	/**
	 * Configures the width for the crosshair - used for ray crosshairs
	 */
	width(inWidth) {
		if (!lib.is_real_number(inWidth)){
			throw this.sequence._customError(this, "width", "inWidth must be of type number");
		}
		this._width = inWidth;
		return this;
	}

	/**
	 * Configures the width for the crosshair - used for ray crosshairs
	 */
	direction(inDirection) {
		if (!lib.is_real_number(inDirection)){
			throw this.sequence._customError(this, "direction", "inDirection must be of type number");
		}
		this._direction = inDirection;
		return this;
	}

	/**
	 * Configures the  increments the direction should snap along
	 */
	snapDirection(inSnapDirection) {
		if (!lib.is_real_number(inSnapDirection)){
			throw this.sequence._customError(this, "snapDirection", "inDirectionSnap must be of type number");
		}
		this._config["snap"]["direction"] = inSnapDirection;
		return this;
	}

	/**
	 * Toggles whether the crosshair can be manually rotated
	 */
	lockManualRotation(inBool = true) {
		if (typeof inBool !== "boolean"){
			throw this.sequence._customError(this, "preventUserRotation", "inBool must be of type number");
		}
		this._config["lockManualRotation"] = inBool;
		return this;
	}

	/**
	 * Toggles whether the crosshair's end position can be dragged
	 * @param inBool
	 */
	lockDrag(inBool = true) {
		if (typeof inBool !== "boolean"){
			throw this.sequence._customError(this, "lockDrag", "inBool must be of type number");
		}
		this._config["lockDrag"] = inBool;
		return this;
	}

	/**
	 * Configures the custom icon to be used on the crosshair
	 */
	icon(inTexture, inOptions = {}) {
		if (typeof inOptions !== "object"){
			throw this.sequence._customError(this, "icon", "inOptions must be of type object");
		}
		inOptions = foundry.utils.mergeObject({ borderVisible: CrosshairsDocument.defaultConfig.icon.borderVisible }, inOptions,);
		if (typeof inTexture !== "string"){
			throw this.sequence._customError(this, "icon", "inTexture must be of type string");
		}
		if (typeof inOptions.borderVisible !== "boolean"){
			throw this.sequence._customError(this, "icon", "inOptions.borderVisible must be of type boolean");
		}
		this._config["icon"]["texture"] = inTexture;
		this._config["icon"]["borderVisible"] = inOptions.borderVisible;
		return this;
	}

	/**
	 * Sets the border transparency of the crosshair
	 */
	borderAlpha(inAlpha) {
		if (!lib.is_real_number(inAlpha)) {
			throw this.sequence._customError(this, "borderAlpha", "inAlpha must be of type number");
		}
		if (inAlpha < 0) inAlpha *= -1;
		while (inAlpha > 1) inAlpha /= 10;
		this._borderAlpha = inAlpha;
		return this;
	}

	/**
	 * Sets the border color of the crosshair
	 */
	borderColor(inColor) {
		this._borderColor = lib.parseColor(inColor);
		return this;
	}

	/**
	 * Sets the fill color of the crosshair
	 */
	fillColor(inColor) {
		this._fillColor = lib.parseColor(inColor);
		return this;
	}

	texture(inTexture, { alpha = 0.5, scale = 1, tile = false } = { alpha: 0.5, scale: 1, tile: false }) {
		if (typeof arguments[1] !== "object") {
			throw this.sequence._customError(this, "texture", "inOptions must be of type object");
		}
		if (!lib.is_real_number(alpha)) {
			throw this.sequence._customError(this, "texture", "inOptions.alpha must be of type number");
		}
		if (!lib.is_real_number(scale)) {
			throw this.sequence._customError(this, "texture", "inOptions.scale must be of type number");
		}
		if (typeof tile !== "boolean") {
			throw this.sequence._customError(this, "texture", "inOptions.tile must be of type boolean");
		}
		if (typeof inTexture !== "string") {
			throw this.sequence._customError(this, "texture", "inTexture must be of type string");
		}
		this._texture = inTexture;
		this._textureAlpha = textureAlpha;
		this._textureScale = scale;
		this._textureTile = tile;
		return this;
	}

	/**
	 * Configures the source location of the crosshair, usually to limit it around the target placeable object, or to
	 * cause it to be limited within a certain range of the placeable object
	 */
	location(inLocation, inOptions = {}) {
		if (!inLocation || typeof inLocation !== "object") {
			throw this.sequence._customError(this, "location", "inLocation is invalid, and must be of type of placeable object, or document");
		}
		if (typeof inOptions !== "object"){
			throw this.sequence._customError(this, "location", "inOptions must be of type object");
		}
		inOptions = foundry.utils.mergeObject({
			limitMinRange: CrosshairsDocument.defaultConfig.location.limitMinRange,
			limitMaxRange: CrosshairsDocument.defaultConfig.location.limitMaxRange,
			showRange: CrosshairsDocument.defaultConfig.location.showRange,
			lockToEdge: CrosshairsDocument.defaultConfig.location.lockToEdge,
			lockToEdgeDirection: CrosshairsDocument.defaultConfig.location.lockToEdgeDirection,
			offset: CrosshairsDocument.defaultConfig.location.offset,
			wallBehavior: CrosshairsDocument.defaultConfig.location.wallBehavior,
			displayRangePoly: CrosshairsDocument.defaultConfig.location.displayRangePoly,
			rangePolyFillColor: CrosshairsDocument.defaultConfig.location.rangePolyFillColor,
			rangePolyLineColor: CrosshairsDocument.defaultConfig.location.rangePolyLineColor,
			rangePolyFillAlpha: CrosshairsDocument.defaultConfig.location.rangePolyFillAlpha,
			rangePolyLineAlpha: CrosshairsDocument.defaultConfig.location.rangePolyLineAlpha,
		}, inOptions,);
		inLocation = this._validateLocation(inLocation);
		if (typeof inOptions.wallBehavior !== "string"){
			throw this.sequence._customError(this, "location", "inOptions.wallBehavior must be of type string");
		}
		if (inLocation === undefined){
			throw this.sequence._customError(this, "location", "could not find position of given object");
		}
		if (inOptions.limitMinRange && !lib.is_real_number(inOptions.limitMinRange)){
			throw this.sequence._customError(this, "location", "inOptions.limitMinRange must be of type number");
		}
		if (inOptions.limitMaxRange && !lib.is_real_number(inOptions.limitMaxRange)){
			throw this.sequence._customError(this, "location", "inOptions.limitMaxRange must be of type number");
		}
		if (typeof inOptions.lockToEdge !== "boolean"){
			throw this.sequence._customError(this, "location", "inOptions.lockToEdge must be of type boolean");
		}
		if (typeof inOptions.showRange !== "boolean"){
			throw this.sequence._customError(this, "location", "inOptions.showRange must be of type boolean");
		}
		if (typeof inOptions.lockToEdgeDirection !== "boolean"){
			throw this.sequence._customError(this, "location", "inOptions.lockToEdgeDirection must be of type boolean");
		}
		if (typeof inOptions.offset !== "object") {
			throw this.sequence._customError(this, "location", "inOptions.offset must be of type of object");
		}
		if (!lib.is_real_number(inOptions.offset.x)) {
			throw this.sequence._customError(this, "location", "inOptions.offset.x must be of type of number");
		}
		if (!lib.is_real_number(inOptions.offset.y)) {
			throw this.sequence._customError(this, "location", "inOptions.offset.y must be of type of number");
		}
		if (typeof inOptions.displayRangePoly !== "boolean"){
			throw this.sequence._customError(this, "location", "inOptions.displayRangePoly must be of type boolean");
		}
		if (inOptions.rangePolyFillColor && !lib.is_real_number(inOptions.rangePolyFillColor)){
			throw this.sequence._customError(this, "location", "inOptions.rangePolyFillColor must be of type number (color, eg 0xFF0000)");
		}
		if (inOptions.rangePolyLineColor && !lib.is_real_number(inOptions.rangePolyLineColor)){
			throw this.sequence._customError(this, "location", "inOptions.rangePolyLineColor must be of type number (color, eg 0xFF0000)");
		}
		if (inOptions.rangePolyFillAlpha && !lib.is_real_number(inOptions.rangePolyFillAlpha)){
			throw this.sequence._customError(this, "location", "inOptions.rangePolyFillAlpha must be of type number");
		}
		if (inOptions.rangePolyLineAlpha && !lib.is_real_number(inOptions.rangePolyLineAlpha)){
			throw this.sequence._customError(this, "location", "inOptions.rangePolyLineAlpha must be of type number");
		}
		this._config["location"] = {
			obj: inLocation?.object ?? inLocation,
			limitMinRange: inOptions.limitMinRange,
			limitMaxRange: inOptions.limitMaxRange,
			lockToEdge: inOptions.lockToEdge,
			lockToEdgeDirection: inOptions.lockToEdgeDirection,
			showRange: inOptions.showRange,
			offset: inOptions.offset,
			wallBehavior: inOptions.wallBehavior,
			displayRangePoly: inOptions.displayRangePoly,
			rangePolyFillColor: inOptions.rangePolyFillColor,
			rangePolyLineColor: inOptions.rangePolyLineColor,
			rangePolyFillAlpha: inOptions.rangePolyFillAlpha,
			rangePolyLineAlpha: inOptions.rangePolyLineAlpha,
		};
		return this;
	}

	/**
	 * Causes the crosshair to spawn a measurable template identical to the crosshair
	 */
	persist(inBool = true) {
		if (typeof inBool !== "boolean"){
			throw this.sequence._customError(this, "persist", "inBool must be of type boolean");
		}
		this._persist = inBool;
		return this;
	}

	/**
	 * Toggles whether this crosshair should highlight the grid
	 */
	gridHighlight(inBool = true) {
		if (typeof inBool !== "boolean"){
			throw this.sequence._customError(this, "gridHighlight", "inBool must be of type boolean");
		}
		this._config['gridHighlight'] = inBool;
		return this;
	}

	/**
	 * Adds a callback function for certain crosshair events
	 */
	callback(inString, inCallback) {
		if (typeof inString !== "string" || !Object.values(CONSTANTS.CALLBACKS).some(str => str === inString)) {
			throw this.sequence._customError(this, "callback", "inString must be of type string and one of Sequencer.Crosshair.CALLBACKS");
		}
		if (!lib.is_function(inCallback)) {
			throw this.sequence._customError(this, "callback", "inCallback must be of type Function");
		}
		this._callbacks[inString] = inCallback;
		return this;
	}

	async run() {

		const reticle = new CrosshairsDocument({
			t: this._type,
			distance: this._distance,
			width: this._width,
			direction: this._direction,
			angle: this._angle,
			borderColor: this._borderColor,
			borderAlpha: this._borderAlpha,
			texture: this._texture,
			textureAlpha: this._textureAlpha,
			textureScale: this._textureScale,
			textureTile: this._textureTile,
			fillColor: this._fillColor,
		}, {
			parent: canvas.scene
		}, this._config, this._callbacks);

		return reticle.show().then(async () => {

			if (this._persist) {
				const [template] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [
					reticle.toObject()
				]);
				this.sequence.crosshairs[this._name] = template;
			}

			if (this._name) {
				this.sequence.nameOffsetMap ||= {};
				this.sequence.nameOffsetMap[this._name] = {
					seed: `${this._name}-${foundry.utils.randomID()}`,
					twister: {},
					source: this.sequence.crosshairs[this._name]?.uuid ?? reticle.getOrientation().source,
					target: this.sequence.crosshairs[this._name]?.uuid ?? reticle.getOrientation().target
				}
			}

		}).catch((err) => {
			console.log(err)
			this.sequence._abort();
		});
	}

	async _execute() {
		await this.run();
	}

	/**
	 * @private
	 */
	_applyTraits() {
		Object.assign(this.constructor.prototype, traits.name);
	}

}
