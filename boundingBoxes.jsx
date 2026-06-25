/**
 * boundingBoxes.jsx
 * After Effects 2026 — ExtendScript
 *
 * Генерирует для всех видимых слоёв активной композиции:
 *   - живые ориентированные bounding box (shape + expression)
 *   - запечённые motion path по ключам Position (bezier + маркеры в ключах)
 *
 * Поддерживает: Text, Shape, Footage (image/video), Precomp, Null.
 * Игнорирует: Audio, Camera, Light, Adjustment.
 *
 * Ограничения:
 *   - Обрабатывает только слои верхнего уровня активной композиции (не внутри precomp).
 *   - Для 3D-слоёв toComp даёт 2D-проекцию через активную камеру.
 *   - Траектория запекается один раз; при правке анимации перезапустите скрипт.
 *   - При дублирующихся именах слоёв expression ссылается на верхний слой с таким именем.
 *   - Повторный запуск удаляет ранее созданные слои с префиксами BBox:/Traj:.
 */

(function () {
    // ─── Настройки ───────────────────────────────────────────────────────────
    var STROKE_WIDTH = 3;
    var DASH_LENGTH = 6;      // длина штриха пунктира (px)
    var DASH_GAP = 4;         // длина разрыва пунктира (px)
    var CROSS_HALF_SIZE = 10; // половина длины луча креста '+' (px)
    var HANDLE_HALF_SIZE = 4; // половина стороны handle-квадрата на bbox (px)
    var TRAJ_KEYFRAME_SQUARE_HALF = 4; // половина стороны квадрата в ключе motion path (px)
    var BOX_PREFIX = "BBox: ";
    var TRAJ_PREFIX = "Traj: ";
    var GROUP_PREFIX = "BBox Group";
    var GENERATE_TRAJECTORY = true;
    var GROUP_UNDER_NULL = false;
    var USE_LABEL_COLORS = true;
    var FALLBACK_COLOR = [1, 0.2, 0.2]; // красный, хорошо виден на любом фоне
    var NULL_DEFAULT_LEFT = -50;
    var NULL_DEFAULT_TOP = -50;
    var NULL_DEFAULT_WIDTH = 100;
    var NULL_DEFAULT_HEIGHT = 100;

    // Стандартные цвета меток AE (RGB 0–1), индексы 1–16
    var LABEL_COLORS = [
        null,
        [0.8, 0.8, 0.8],
        [0.8, 0.2, 0.2],
        [1.0, 0.55, 0.26],
        [0.2, 0.65, 0.32],
        [0.2, 0.45, 0.9],
        [0.55, 0.35, 0.85],
        [0.95, 0.55, 0.75],
        [0.55, 0.75, 0.25],
        [0.15, 0.55, 0.55],
        [0.65, 0.45, 0.25],
        [0.85, 0.2, 0.55],
        [0.25, 0.7, 0.35],
        [0.75, 0.75, 0.2],
        [0.45, 0.45, 0.75],
        [0.35, 0.35, 0.35],
        [0.15, 0.15, 0.15]
    ];

    // ─── Точка входа ─────────────────────────────────────────────────────────
    function main() {
        var comp = app.project.activeItem;

        if (!(comp instanceof CompItem)) {
            alert("Откройте композицию и запустите скрипт снова.");
            return;
        }

        app.beginUndoGroup("Bounding Boxes");

        try {
            ensureJavaScriptExpressionEngine();

            removeGeneratedLayers(comp);

            var collected = collectTargetLayers(comp);
            var targets = collected.targets;
            var stats = collected.stats;

            if (targets.length === 0) {
                alert(
                    "Нет подходящих слоёв.\n\n" +
                    "Всего в композиции: " + stats.total + "\n" +
                    "Отключены: " + stats.disabled + "\n" +
                    "Без видео (audio/adjustment): " + stats.noVideo + "\n" +
                    "Guide / служебные: " + stats.guideOrGenerated
                );
                app.endUndoGroup();
                return;
            }

            var parentNull = GROUP_UNDER_NULL ? createGroupNull(comp) : null;
            var createdLayers = [];
            var skipped = 0;
            var errors = [];

            var captured = [];
            var ci;

            for (ci = 0; ci < targets.length; ci++) {
                var src = safeGetLayer(comp, targets[ci].index);
                if (!src) {
                    skipped++;
                    continue;
                }
                try {
                    captured.push({
                        info: captureSourceLayerInfo(src, comp),
                        color: colorForLayer(src),
                        suffix: " #" + targets[ci].index
                    });
                } catch (captureErr) {
                    skipped++;
                    errors.push(targets[ci].name + " [capture]: " + captureErr.toString());
                }
            }

            for (ci = 0; ci < captured.length; ci++) {
                var entry = captured[ci];
                try {
                    var boxLayer = createBoundingBox(comp, entry.info, entry.color, entry.suffix);
                    if (boxLayer) {
                        createdLayers.push(boxLayer);
                    }

                    if (GENERATE_TRAJECTORY && entry.info.motionPath.vertices.length >= 2) {
                        var trajLayer = createTrajectory(comp, entry.info, entry.color, entry.suffix);
                        if (trajLayer) {
                            createdLayers.push(trajLayer);
                        }
                    }
                } catch (layerErr) {
                    skipped++;
                    errors.push(entry.info.name + " [create]: " + layerErr.toString());
                }
            }

            if (parentNull) {
                for (var j = 0; j < createdLayers.length; j++) {
                    createdLayers[j].parent = parentNull;
                }
            }

            moveLayersToTop(comp, createdLayers);

            alert(
                "Готово.\n\n" +
                "Слоёв в композиции: " + stats.total + "\n" +
                "Подходящих целей: " + targets.length + "\n" +
                "Создано overlay-слоёв: " + createdLayers.length + "\n" +
                "Пропущено: " + skipped + "\n\n" +
                "Не обработано: " + (stats.total - targets.length) + " слоёв\n" +
                "  — отключены: " + stats.disabled + "\n" +
                "  — audio/adjustment: " + stats.noVideo + "\n" +
                "  — camera/light/guide: " + stats.notAV + "\n" +
                "  — служебные BBox: " + stats.guideOrGenerated +
                (errors.length > 0 ? "\n\nОшибки (" + errors.length + "):\n" + errors.slice(0, 5).join("\n") : "")
            );
        } catch (e) {
            alert("Ошибка: " + e.toString() + (e.line ? " (строка " + e.line + ")" : ""));
        }

        app.endUndoGroup();
    }

    // ─── Фильтрация и очистка ────────────────────────────────────────────────
    function safeGetLayer(comp, index) {
        try {
            if (!comp || index < 1 || index > comp.numLayers) {
                return null;
            }
            return comp.layer(index);
        } catch (e) {
            return null;
        }
    }

    function isGeneratedLayer(layer) {
        try {
            if (!layer) {
                return false;
            }
            var name = layer.name;
            return (
                name.indexOf(BOX_PREFIX) === 0 ||
                name.indexOf(TRAJ_PREFIX) === 0 ||
                name === GROUP_PREFIX
            );
        } catch (e) {
            return false;
        }
    }

    function isNullLayer(layer) {
        try {
            return layer.nullLayer === true;
        } catch (e) {
            return false;
        }
    }

    function isTextLayer(layer) {
        try {
            return layer.property("ADBE Text Properties") !== null;
        } catch (e) {
            return false;
        }
    }

    function isShapeLayer(layer) {
        try {
            return layer.property("ADBE Root Vectors Group") !== null &&
                layer.property("ADBE Text Properties") === null;
        } catch (e) {
            return false;
        }
    }

    function isCameraOrLight(layer) {
        try {
            if (typeof CameraLayer !== "undefined" && layer instanceof CameraLayer) {
                return true;
            }
            if (typeof LightLayer !== "undefined" && layer instanceof LightLayer) {
                return true;
            }
        } catch (e) {}
        return false;
    }

    function isAudioOnly(layer) {
        try {
            if (isNullLayer(layer)) {
                return false;
            }
            if (layer.hasVideo) {
                return false;
            }
            if (isTextLayer(layer) || isShapeLayer(layer)) {
                return false;
            }
            return layer.hasAudio === true;
        } catch (e) {
            return false;
        }
    }

    function collectTargetLayers(comp) {
        var result = [];
        var stats = {
            total: comp.numLayers,
            disabled: 0,
            noVideo: 0,
            notAV: 0,
            guideOrGenerated: 0
        };

        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = safeGetLayer(comp, i);
            if (!layer) {
                continue;
            }

            if (isGeneratedLayer(layer)) {
                stats.guideOrGenerated++;
                continue;
            }
            if (!layer.enabled) {
                stats.disabled++;
                continue;
            }
            if (layer.guideLayer) {
                stats.guideOrGenerated++;
                continue;
            }
            if (isCameraOrLight(layer)) {
                stats.notAV++;
                continue;
            }
            if (isAudioOnly(layer)) {
                stats.noVideo++;
                continue;
            }

            result.push({
                index: i,
                name: layer.name
            });
        }

        return { targets: result, stats: stats };
    }

    function removeGeneratedLayers(comp) {
        var namesToRemove = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = safeGetLayer(comp, i);
            if (layer && isGeneratedLayer(layer)) {
                namesToRemove.push(layer.name);
            }
        }
        for (var j = 0; j < namesToRemove.length; j++) {
            var target = findLayerByName(comp, namesToRemove[j]);
            if (target) {
                try {
                    target.remove();
                } catch (e) {}
            }
        }
    }

    function findLayerByName(comp, name) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = safeGetLayer(comp, i);
            if (layer && layer.name === name) {
                return layer;
            }
        }
        return null;
    }

    // ─── Цвета ───────────────────────────────────────────────────────────────
    function captureSourceLayerInfo(sourceLayer, comp) {
        var motionPath = { vertices: [], inTangents: [], outTangents: [], keyframePoints: [] };
        if (GENERATE_TRAJECTORY) {
            try {
                motionPath = collectMotionPathData(sourceLayer);
            } catch (e) {
                motionPath = { vertices: [], inTangents: [], outTangents: [], keyframePoints: [] };
            }
        }

        return {
            name: sourceLayer.name,
            label: safeLayerLabel(sourceLayer),
            startTime: sourceLayer.startTime,
            inPoint: sourceLayer.inPoint,
            outPoint: sourceLayer.outPoint,
            stretch: safeLayerStretch(sourceLayer),
            enabled: sourceLayer.enabled,
            motionPath: motionPath
        };
    }

    function safeLayerLabel(layer) {
        try {
            return layer.label;
        } catch (e) {
            return 1;
        }
    }

    function safeLayerStretch(layer) {
        try {
            return layer.stretch;
        } catch (e) {
            return 100;
        }
    }

    function applyLayerTiming(targetLayer, info) {
        targetLayer.startTime = info.startTime;
        targetLayer.inPoint = info.inPoint;
        targetLayer.outPoint = info.outPoint;
        try {
            targetLayer.stretch = info.stretch;
        } catch (e) {}
        try {
            targetLayer.enabled = info.enabled;
        } catch (e) {}
    }

    function colorForLayer(layer) {
        if (!USE_LABEL_COLORS) {
            return FALLBACK_COLOR;
        }
        var idx = layer.label;
        if (idx >= 1 && idx < LABEL_COLORS.length && LABEL_COLORS[idx]) {
            return LABEL_COLORS[idx];
        }
        return FALLBACK_COLOR;
    }

    // ─── Bounding Box (живой, expression) ────────────────────────────────────
    function createBoundingBox(comp, info, color, uniqueSuffix) {
        var layerName = BOX_PREFIX + info.name + uniqueSuffix;
        var setup = createBBoxShapeLayer(comp, layerName, info.label, color);

        var expressions = buildBBoxExpressions(info.name);
        setPathExpression(setup.dashedPaths[0], expressions[0]);
        setPathExpression(setup.dashedPaths[1], expressions[1]);
        setPathExpression(setup.solidPaths[0], expressions[2]);
        setPathExpression(setup.solidPaths[1], expressions[3]);

        var handleExpressions = buildHandleExpressions(info.name);
        for (var hi = 0; hi < handleExpressions.length; hi++) {
            setPathExpression(setup.handlePaths[hi], handleExpressions[hi]);
        }

        applyLayerTiming(setup.layer, info);

        return setup.layer;
    }

    function bboxCornersSnippet(safeName) {
        return [
            'var L = thisComp.layer("' + safeName + '");',
            "var r = L.sourceRectAtTime(time, false);",
            "var ok = r.width > 0 && r.height > 0;",
            "if (!ok && L.nullLayer) {",
            "    r = { left: " + NULL_DEFAULT_LEFT + ", top: " + NULL_DEFAULT_TOP +
                ", width: " + NULL_DEFAULT_WIDTH + ", height: " + NULL_DEFAULT_HEIGHT + " };",
            "    ok = true;",
            "}",
            "var tl = ok ? fromComp(L.toComp([r.left, r.top])) : [0, 0];",
            "var tr = ok ? fromComp(L.toComp([r.left + r.width, r.top])) : [0, 0];",
            "var br = ok ? fromComp(L.toComp([r.left + r.width, r.top + r.height])) : [0, 0];",
            "var bl = ok ? fromComp(L.toComp([r.left, r.top + r.height])) : [0, 0];"
        ];
    }

    function bboxAxesSnippet() {
        return [
            "var ax = [tr[0] - tl[0], tr[1] - tl[1]];",
            "var axLen = length(ax);",
            "if (axLen > 0) ax = [ax[0] / axLen, ax[1] / axLen]; else ax = [1, 0];",
            "var ay = [bl[0] - tl[0], bl[1] - tl[1]];",
            "var ayLen = length(ay);",
            "if (ayLen > 0) ay = [ay[0] / ayLen, ay[1] / ayLen]; else ay = [0, 1];",
            "var hs = " + HANDLE_HALF_SIZE + ";"
        ];
    }

    function buildBBoxExpressions(sourceLayerName) {
        var safeName = escapeForExpression(sourceLayerName);
        var corners = bboxCornersSnippet(safeName);
        var crossH = CROSS_HALF_SIZE;

        var rectExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    createPath([tl, tr, br, bl], [], [], true);",
            "}"
        ]);

        var triangleExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    var apex = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2];",
            "    createPath([apex, br, bl], [], [], true);",
            "}"
        ]);

        var crossHExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    var c = [(tl[0] + tr[0] + br[0] + bl[0]) / 4, (tl[1] + tr[1] + br[1] + bl[1]) / 4];",
            "    var ax = [tr[0] - tl[0], tr[1] - tl[1]];",
            "    var axLen = length(ax);",
            "    if (axLen > 0) ax = [ax[0] / axLen, ax[1] / axLen]; else ax = [1, 0];",
            "    var ch = " + crossH + ";",
            "    createPath([",
            "        [c[0] - ax[0] * ch, c[1] - ax[1] * ch],",
            "        [c[0] + ax[0] * ch, c[1] + ax[1] * ch]",
            "    ], [], [], false);",
            "}"
        ]);

        var crossVExpr = corners.concat([
            "if (!ok) {",
            "    createPath([[0, 0]], [], [], false);",
            "} else {",
            "    var c = [(tl[0] + tr[0] + br[0] + bl[0]) / 4, (tl[1] + tr[1] + br[1] + bl[1]) / 4];",
            "    var ay = [bl[0] - tl[0], bl[1] - tl[1]];",
            "    var ayLen = length(ay);",
            "    if (ayLen > 0) ay = [ay[0] / ayLen, ay[1] / ayLen]; else ay = [0, 1];",
            "    var ch = " + crossH + ";",
            "    createPath([",
            "        [c[0] - ay[0] * ch, c[1] - ay[1] * ch],",
            "        [c[0] + ay[0] * ch, c[1] + ay[1] * ch]",
            "    ], [], [], false);",
            "}"
        ]);

        return [
            rectExpr.join("\n"),
            triangleExpr.join("\n"),
            crossHExpr.join("\n"),
            crossVExpr.join("\n")
        ];
    }

    function buildHandleExpressions(sourceLayerName) {
        var safeName = escapeForExpression(sourceLayerName);
        var prefix = bboxCornersSnippet(safeName).concat(bboxAxesSnippet());
        var pointDefs = [
            "var p = tl;",
            "var p = tr;",
            "var p = br;",
            "var p = bl;",
            "var p = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2];",
            "var p = [(tr[0] + br[0]) / 2, (tr[1] + br[1]) / 2];",
            "var p = [(bl[0] + br[0]) / 2, (bl[1] + br[1]) / 2];",
            "var p = [(tl[0] + bl[0]) / 2, (tl[1] + bl[1]) / 2];"
        ];
        var squareBody = [
            "    createPath([",
            "        [p[0] - ax[0] * hs - ay[0] * hs, p[1] - ax[1] * hs - ay[1] * hs],",
            "        [p[0] + ax[0] * hs - ay[0] * hs, p[1] + ax[1] * hs - ay[1] * hs],",
            "        [p[0] + ax[0] * hs + ay[0] * hs, p[1] + ax[1] * hs + ay[1] * hs],",
            "        [p[0] - ax[0] * hs + ay[0] * hs, p[1] - ax[1] * hs + ay[1] * hs]",
            "    ], [], [], true);"
        ];
        var result = [];

        for (var i = 0; i < pointDefs.length; i++) {
            result.push(prefix.concat([
                "if (!ok) {",
                "    createPath([[0, 0]], [], [], false);",
                "} else {",
                pointDefs[i]
            ]).concat(squareBody).concat(["}"]).join("\n"));
        }

        return result;
    }

    // ─── Траектория (motion path по ключам Position) ───────────────────────────
    function createTrajectory(comp, info, color, uniqueSuffix) {
        var motionPath = info.motionPath;
        var markerCount = motionPath.keyframePoints.length;
        var layerName = TRAJ_PREFIX + info.name + uniqueSuffix;
        var setup = createTrajectoryShapeLayer(comp, layerName, info.label, color, markerCount);

        setup.path.setValue(buildMotionPathShape(motionPath));

        for (var mi = 0; mi < markerCount; mi++) {
            setup.markerPaths[mi].setValue(
                buildKeyframeSquareShape(motionPath.keyframePoints[mi], TRAJ_KEYFRAME_SQUARE_HALF)
            );
        }

        applyLayerTiming(setup.layer, info);

        return setup.layer;
    }

    function getPositionPropertyInfo(layer) {
        var transform = layer.property("ADBE Transform Group");
        var pos = transform.property("ADBE Position");

        try {
            if (pos.dimensionsSeparated) {
                return {
                    separated: true,
                    props: [
                        transform.property("ADBE Position_0"),
                        transform.property("ADBE Position_1")
                    ]
                };
            }
        } catch (e) {}

        return { separated: false, pos: pos };
    }

    function isSpatialPosition(posInfo) {
        if (posInfo.separated) {
            return false;
        }
        try {
            if (posInfo.pos.isSpatial) {
                return true;
            }
            var pvt = posInfo.pos.propertyValueType;
            return (
                pvt === PropertyValueType.TwoD_SPATIAL ||
                pvt === PropertyValueType.ThreeD_SPATIAL
            );
        } catch (e) {
            return false;
        }
    }

    function collectPositionKeyframeTimes(layer) {
        var posInfo = getPositionPropertyInfo(layer);
        var props = posInfo.separated ? posInfo.props : [posInfo.pos];
        var timeMap = {};
        var times = [];
        var pi;
        var k;

        for (pi = 0; pi < props.length; pi++) {
            var prop = props[pi];
            if (!prop || prop.numKeys === 0) {
                continue;
            }
            for (k = 1; k <= prop.numKeys; k++) {
                var keyTime = prop.keyTime(k);
                if (keyTime >= layer.inPoint - 0.0001 && keyTime <= layer.outPoint + 0.0001) {
                    var key = keyTime.toFixed(6);
                    if (!timeMap[key]) {
                        timeMap[key] = keyTime;
                        times.push(keyTime);
                    }
                }
            }
        }

        times.sort(function (a, b) {
            return a - b;
        });

        return { times: times, posInfo: posInfo };
    }

    function compTangentFromLayerSpatial(layer, time, keyIndex, posInfo, direction) {
        var pos = posInfo.pos;
        var layerPos = pos.keyValue(keyIndex);
        var px = layerPos[0];
        var py = layerPos[1];
        var tangent;

        if (direction === "out") {
            tangent = pos.keyOutSpatialTangent(keyIndex);
        } else {
            tangent = pos.keyInSpatialTangent(keyIndex);
        }

        var compBase = transformPointToComp(layer, [px, py], time);
        var compTip = transformPointToComp(layer, [px + tangent[0], py + tangent[1]], time);
        return [compTip[0] - compBase[0], compTip[1] - compBase[1]];
    }

    function collectMotionPathData(layer) {
        var empty = {
            vertices: [],
            inTangents: [],
            outTangents: [],
            keyframePoints: []
        };
        var collected = collectPositionKeyframeTimes(layer);
        var times = collected.times;
        var posInfo = collected.posInfo;
        var spatial = isSpatialPosition(posInfo);
        var vertices = [];
        var inTangents = [];
        var outTangents = [];
        var keyframePoints = [];
        var i;

        for (i = 0; i < times.length; i++) {
            var t = times[i];
            var vtx = layerAnchorToComp(layer, t);
            if (!vtx) {
                continue;
            }

            vertices.push(vtx);
            keyframePoints.push(vtx);

            var inTan = [0, 0];
            var outTan = [0, 0];

            if (spatial) {
                var keyIndex = posInfo.pos.nearestKeyIndex(t);
                if (Math.abs(posInfo.pos.keyTime(keyIndex) - t) < 0.0001) {
                    try {
                        inTan = compTangentFromLayerSpatial(layer, t, keyIndex, posInfo, "in");
                        outTan = compTangentFromLayerSpatial(layer, t, keyIndex, posInfo, "out");
                    } catch (e) {}
                }
            }

            inTangents.push(inTan);
            outTangents.push(outTan);
        }

        if (vertices.length < 2) {
            return empty;
        }

        return {
            vertices: vertices,
            inTangents: inTangents,
            outTangents: outTangents,
            keyframePoints: keyframePoints
        };
    }

    function buildMotionPathShape(motionPath) {
        var shape = new Shape();
        shape.vertices = motionPath.vertices;
        shape.inTangents = motionPath.inTangents;
        shape.outTangents = motionPath.outTangents;
        shape.closed = false;
        return shape;
    }

    function buildKeyframeSquareShape(center, half) {
        var x = center[0];
        var y = center[1];
        var h = half;
        var shape = new Shape();
        shape.vertices = [
            [x - h, y - h],
            [x + h, y - h],
            [x + h, y + h],
            [x - h, y + h]
        ];
        shape.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        shape.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        shape.closed = true;
        return shape;
    }

    function createTrajectoryShapeLayer(comp, layerName, label, color, markerCount) {
        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = layerName;
        shapeLayer.label = label;
        shapeLayer.threeDLayer = false;

        var root = shapeLayer.property("ADBE Root Vectors Group");

        var pathGroup = root.addProperty("ADBE Vector Group");
        var pathContents = pathGroup.property("ADBE Vectors Group");
        addPathsToGroup(pathContents, 1);
        addStrokeToGroup(pathContents, color, false);

        var markerPaths = [];
        if (markerCount > 0) {
            var markerGroup = root.addProperty("ADBE Vector Group");
            var markerContents = markerGroup.property("ADBE Vectors Group");
            addPathsToGroup(markerContents, markerCount);
            addStrokeToGroup(markerContents, color, false);
            markerPaths = getFreshPathsInGroup(shapeLayer, 2, markerCount);
        }

        zeroTransform(shapeLayer);

        return {
            layer: shapeLayer,
            path: getFreshPathsInGroup(shapeLayer, 1, 1)[0],
            markerPaths: markerPaths
        };
    }

    function addPathsToGroup(groupContents, count) {
        for (var p = 0; p < count; p++) {
            groupContents.addProperty("ADBE Vector Shape - Group");
        }
    }

    function addStrokeToGroup(groupContents, color, dashed) {
        var stroke = groupContents.addProperty("ADBE Vector Graphic - Stroke");
        stroke.property("ADBE Vector Stroke Color").setValue(color);
        stroke.property("ADBE Vector Stroke Width").setValue(STROKE_WIDTH);

        if (dashed) {
            var dashes = stroke.property("ADBE Vector Stroke Dashes");
            dashes.addProperty("ADBE Vector Stroke Dash 1").setValue(DASH_LENGTH);
            dashes.addProperty("ADBE Vector Stroke Gap 1").setValue(DASH_GAP);
        }

        var fill = groupContents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Opacity").setValue(0);
    }

    function createBBoxShapeLayer(comp, layerName, label, color) {
        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = layerName;
        shapeLayer.label = label;
        shapeLayer.threeDLayer = false;

        var root = shapeLayer.property("ADBE Root Vectors Group");

        var dashedGroup = root.addProperty("ADBE Vector Group");
        var dashedContents = dashedGroup.property("ADBE Vectors Group");
        addPathsToGroup(dashedContents, 2);
        addStrokeToGroup(dashedContents, color, true);

        var solidGroup = root.addProperty("ADBE Vector Group");
        var solidContents = solidGroup.property("ADBE Vectors Group");
        addPathsToGroup(solidContents, 2);
        addStrokeToGroup(solidContents, color, false);

        var handlesGroup = root.addProperty("ADBE Vector Group");
        var handlesContents = handlesGroup.property("ADBE Vectors Group");
        addPathsToGroup(handlesContents, 8);
        addStrokeToGroup(handlesContents, color, false);

        zeroTransform(shapeLayer);

        var dashedPaths = getFreshPathsInGroup(shapeLayer, 1, 2);
        var solidPaths = getFreshPathsInGroup(shapeLayer, 2, 2);
        var handlePaths = getFreshPathsInGroup(shapeLayer, 3, 8);

        return {
            layer: shapeLayer,
            dashedPaths: dashedPaths,
            solidPaths: solidPaths,
            handlePaths: handlePaths
        };
    }

    function getFreshPathAt(shapeLayer, groupIndex, pathIndex) {
        var root = shapeLayer.property("ADBE Root Vectors Group");
        var group = root.property(groupIndex);
        var gc = group.property("ADBE Vectors Group");
        var found = 0;

        for (var i = 1; i <= gc.numProperties; i++) {
            var prop = gc.property(i);
            if (prop.matchName === "ADBE Vector Shape - Group") {
                if (found === pathIndex) {
                    return prop.property("ADBE Vector Shape");
                }
                found++;
            }
        }

        return null;
    }

    function getFreshPathsInGroup(shapeLayer, groupIndex, count) {
        var paths = [];
        for (var i = 0; i < count; i++) {
            var pathProp = getFreshPathAt(shapeLayer, groupIndex, i);
            if (!pathProp) {
                throw new Error("Path property not found at group " + groupIndex + ", index " + i);
            }
            paths.push(pathProp);
        }
        return paths;
    }

    function layerAnchorToComp(layer, time) {
        try {
            var anchor = layer.property("ADBE Transform Group").property("ADBE Anchor Point").valueAtTime(time, false);
            var point = [anchor[0], anchor[1]];
            if (typeof layer.toComp === "function") {
                return layer.toComp(point, time);
            }
            return transformPointToComp(layer, point, time);
        } catch (e) {
            return null;
        }
    }

    function transformPointToComp(layer, point, time) {
        var current = layer;
        var x = point[0];
        var y = point[1];

        while (current) {
            var t = current.property("ADBE Transform Group");
            var ap = t.property("ADBE Anchor Point").valueAtTime(time, false);
            var pos = t.property("ADBE Position").valueAtTime(time, false);
            var scale = t.property("ADBE Scale").valueAtTime(time, false);
            var rot = t.property("ADBE Rotate Z").valueAtTime(time, false);
            var rad = rot * Math.PI / 180;
            var cos = Math.cos(rad);
            var sin = Math.sin(rad);
            var sx = scale[0] / 100;
            var sy = scale[1] / 100;

            x -= ap[0];
            y -= ap[1];
            x *= sx;
            y *= sy;
            var rx = x * cos - y * sin;
            var ry = x * sin + y * cos;
            x = rx + pos[0];
            y = ry + pos[1];

            current = current.parent;
        }

        return [x, y];
    }

    // ─── Вспомогательные ─────────────────────────────────────────────────────
    function ensureJavaScriptExpressionEngine() {
        try {
            if (app.project.expressionEngine !== "javascript-1.0") {
                app.project.expressionEngine = "javascript-1.0";
            }
        } catch (e) {
            // старые версии AE — продолжаем с текущим движком
        }
    }

    function setPathExpression(pathProperty, expr) {
        var placeholder = new Shape();
        placeholder.vertices = [[0, 0], [10, 0], [10, 10], [0, 10]];
        placeholder.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        placeholder.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
        placeholder.closed = true;
        pathProperty.setValue(placeholder);
        pathProperty.expression = expr;
    }

    function zeroTransform(layer) {
        var transform = layer.property("ADBE Transform Group");
        transform.property("ADBE Anchor Point").setValue([0, 0]);
        transform.property("ADBE Position").setValue([0, 0]);
        transform.property("ADBE Scale").setValue([100, 100]);
        transform.property("ADBE Rotate Z").setValue(0);
        transform.property("ADBE Opacity").setValue(100);
    }

    function moveLayersToTop(comp, layers) {
        for (var i = layers.length - 1; i >= 0; i--) {
            if (layers[i]) {
                layers[i].moveToBeginning();
            }
        }
    }

    function createGroupNull(comp) {
        var nullLayer = comp.layers.addNull();
        nullLayer.name = GROUP_PREFIX;
        nullLayer.label = 9;
        return nullLayer;
    }

    function escapeForExpression(name) {
        return name
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n");
    }

    main();
})();
