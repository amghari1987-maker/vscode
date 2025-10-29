/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { getWindow, n } from '../../../../../../../base/browser/dom.js';
import { IMouseEvent, StandardMouseEvent } from '../../../../../../../base/browser/mouseEvent.js';
import { Color } from '../../../../../../../base/common/color.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IObservable, IReader, autorun, constObservable, derived, derivedObservableWithCache, observableFromEvent, observableValue } from '../../../../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../../../platform/theme/common/themeService.js';
import { ICodeEditor } from '../../../../../../browser/editorBrowser.js';
import { observableCodeEditor } from '../../../../../../browser/observableCodeEditor.js';
import { Rect } from '../../../../../../common/core/2d/rect.js';
import { EmbeddedCodeEditorWidget } from '../../../../../../browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { Position } from '../../../../../../common/core/position.js';
import { Range } from '../../../../../../common/core/range.js';
import { IModelDeltaDecoration, ITextModel } from '../../../../../../common/model.js';
import { InlineCompletionContextKeys } from '../../../controller/inlineCompletionContextKeys.js';
import { IInlineEditsView, InlineEditTabAction } from '../inlineEditsViewInterface.js';
import { InlineEditWithChanges } from '../inlineEditWithChanges.js';
import { originalBackgroundColor } from '../theme.js';
import { getContentRenderWidth, maxContentWidthInRange } from '../utils/utils.js';
import { DetailedLineRangeMapping } from '../../../../../../common/diff/rangeMapping.js';
import { ModelDecorationOptions } from '../../../../../../common/model/textModel.js';
import { OffsetRange } from '../../../../../../common/core/ranges/offsetRange.js';
import { InlineEditsGutterIndicator } from '../components/gutterIndicatorView.js';
import { LineRange } from '../../../../../../common/core/ranges/lineRange.js';
import { ModelPerInlineEdit } from '../inlineEditsModel.js';

const HORIZONTAL_PADDING = 0;
const VERTICAL_PADDING = 0;

const BORDER_WIDTH = 1;
const WIDGET_SEPARATOR_WIDTH = 1;
const BORDER_RADIUS = 4;
const ORIGINAL_END_PADDING = 20;
const MODIFIED_END_PADDING = 12;

export class InlineEditsLongDistanceHint extends Disposable implements IInlineEditsView {
	// This is an approximation and should be improved by using the real parameters used bellow
	static fitsInsideViewport(editor: ICodeEditor, textModel: ITextModel, edit: InlineEditWithChanges, reader: IReader): boolean {
		const editorObs = observableCodeEditor(editor);
		const editorWidth = editorObs.layoutInfoWidth.read(reader);
		const editorContentLeft = editorObs.layoutInfoContentLeft.read(reader);
		const editorVerticalScrollbar = editor.getLayoutInfo().verticalScrollbarWidth;
		const minimapWidth = editorObs.layoutInfoMinimap.read(reader).minimapLeft !== 0 ? editorObs.layoutInfoMinimap.read(reader).minimapWidth : 0;

		const maxOriginalContent = maxContentWidthInRange(editorObs, edit.displayRange, undefined/* do not reconsider on each layout info change */);
		const maxModifiedContent = edit.lineEdit.newLines.reduce((max, line) => Math.max(max, getContentRenderWidth(line, editor, textModel)), 0);
		const originalPadding = ORIGINAL_END_PADDING; // padding after last line of original editor
		const modifiedPadding = MODIFIED_END_PADDING + 2 * BORDER_WIDTH; // padding after last line of modified editor

		return maxOriginalContent + maxModifiedContent + originalPadding + modifiedPadding < editorWidth - editorContentLeft - editorVerticalScrollbar - minimapWidth;
	}

	private readonly _editorObs;

	private readonly _onDidClick;
	readonly onDidClick;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _viewState: IObservable<ILongDistanceViewState | undefined>,
		private readonly _previewTextModel: ITextModel,
		private readonly _tabAction: IObservable<InlineEditTabAction>,
		private readonly _model: IObservable<ModelPerInlineEdit | undefined>,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IThemeService private readonly _themeService: IThemeService
	) {
		super();
		this._editorObs = observableCodeEditor(this._editor);
		this._onDidClick = this._register(new Emitter<IMouseEvent>());
		this.onDidClick = this._onDidClick.event;
		this._display = derived(this, reader => !!this._viewState.read(reader) ? 'block' : 'none');
		this.previewRef = n.ref<HTMLDivElement>();

		const editorContainerRef = n.ref<HTMLDivElement>();

		const separatorWidthObs = constObservable(WIDGET_SEPARATOR_WIDTH);
		this._widgetContent = n.div({
			style: { position: 'absolute', overflow: 'hidden', cursor: 'pointer', background: '#313131', padding: 3, borderRadius: BORDER_RADIUS, display: 'flex', flexDirection: 'column' },
			onmousedown: e => {
				e.preventDefault(); // This prevents that the editor loses focus
			},
			onclick: (e) => {
				this._onDidClick.fire(new StandardMouseEvent(getWindow(e), e));
			}
		}, [
			n.div({
				class: ['editorContainer'],
				style: { overflow: 'hidden', padding: 2, background: '#1f1f1f' },
				ref: editorContainerRef,
			}, [
				n.div({ class: 'preview', style: { /*pointerEvents: 'none'*/ }, ref: this.previewRef }),
			]),
			n.div({ class: 'bar', style: { pointerEvents: 'none', height: 20 } }),
		]).keepUpdated(this._store);

		this.isHovered = this._widgetContent.didMouseMoveDuringHover;
		this.previewEditor = this._register(this._instantiationService.createInstance(
			EmbeddedCodeEditorWidget,
			this.previewRef.element,
			{
				glyphMargin: false,
				lineNumbers: 'on',
				minimap: { enabled: false },
				guides: {
					indentation: false,
					bracketPairs: false,
					bracketPairsHorizontal: false,
					highlightActiveIndentation: false,
				},

				rulers: [],
				padding: { top: 0, bottom: 0 },
				//folding: false,
				selectOnLineNumbers: false,
				selectionHighlight: false,
				columnSelection: false,
				overviewRulerBorder: false,
				overviewRulerLanes: 0,
				//lineDecorationsWidth: 0,
				//lineNumbersMinChars: 0,
				revealHorizontalRightPadding: 0,
				bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
				scrollBeyondLastLine: false,
				scrollbar: {
					vertical: 'hidden',
					horizontal: 'hidden',
					handleMouseWheel: false,
				},
				readOnly: true,
				wordWrap: 'off',
				wordWrapOverride1: 'off',
				wordWrapOverride2: 'off',
			},
			{
				contextKeyValues: {
					[InlineCompletionContextKeys.inInlineEditsPreviewEditor.key]: true,
				},
				contributions: [],
			},
			this._editor
		));
		this._previewEditorObs = observableCodeEditor(this.previewEditor);

		this._instantiationService.createInstance(
			InlineEditsGutterIndicator,
			this._previewEditorObs,
			derived(reader => LineRange.ofLength(this._viewState.read(reader)!.diff[0].modified.startLineNumber, 1)),
			constObservable(0),
			this._model,
			constObservable(false),
			observableValue(this, false),
		);

		this._register(this._previewEditorObs.setDecorations(this._decorations));



		//function

		const horizontalContentRangeInPreviewEditorToShow = derived(this, reader => {
			return getHorizontalContentRangeInPreviewEditorToShow(this.previewEditor, this._viewState.read(reader)?.diff ?? []);
		});
		function getHorizontalContentRangeInPreviewEditorToShow(editor: ICodeEditor, diff: DetailedLineRangeMapping[]): OffsetRange {
			return new OffsetRange(55, 400);
			return new OffsetRange(0, editor.getContentWidth());
		}

		this._updatePreviewEditor = derived(this, reader => {
			this._widgetContent.readEffect(reader);
			this._previewEditorObs.model.read(reader); // update when the model is set

			// Setting this here explicitly to make sure that the preview editor is
			// visible when needed, we're also checking that these fields are defined
			// because of the auto run initial
			// Before removing these, verify with a non-monospace font family
			this._display.read(reader);
			if (this._view) {
				this._view.element.style.display = this._display.read(reader);
			}

			const viewState = this._viewState.read(reader);
			if (!viewState) {
				return;
			}

			const range = viewState.edit.originalLineRange;

			const hiddenAreas: Range[] = [];
			if (range.startLineNumber > 1) {
				hiddenAreas.push(new Range(1, 1, range.startLineNumber - 1, 1));
			}
			if (range.startLineNumber + viewState.newTextLineCount < this._previewTextModel.getLineCount() + 1) {
				hiddenAreas.push(new Range(range.startLineNumber + viewState.newTextLineCount, 1, this._previewTextModel.getLineCount() + 1, 1));
			}

			this.previewEditor.setHiddenAreas(hiddenAreas, undefined, true);
		});
		this._previewEditorWidth = derived(this, reader => {
			const viewState = this._viewState.read(reader);
			if (!viewState) { return 0; }
			this._updatePreviewEditor.read(reader);

			return maxContentWidthInRange(this._previewEditorObs, viewState.edit.modifiedLineRange, reader);
		});
		this._cursorPosIfTouchesEdit = derived(this, reader => {
			const cursorPos = this._editorObs.cursorPosition.read(reader);
			const viewState = this._viewState.read(reader);
			if (!viewState || !cursorPos) { return undefined; }
			return viewState.edit.modifiedLineRange.contains(cursorPos.lineNumber) ? cursorPos : undefined;
		});


		this._hintTextPosition = derived(this, (reader) => {
			const viewState = this._viewState.read(reader);
			return viewState ? new Position(viewState.hint.lineNumber, Number.MAX_SAFE_INTEGER) : null;
		});
		this._hintTopLeft = this._editorObs.observePosition(this._hintTextPosition, this._store);


		this._originalDisplayRange = this._viewState.map(e => e?.edit.displayRange);
		this._editorMaxContentWidthInRange = derived(this, reader => {
			const originalDisplayRange = this._originalDisplayRange.read(reader);
			if (!originalDisplayRange) {
				return constObservable(0);
			}
			this._editorObs.versionId.read(reader);

			// Take the max value that we observed.
			// Reset when either the edit changes or the editor text version.
			return derivedObservableWithCache<number>(this, (reader, lastValue) => {
				const maxWidth = maxContentWidthInRange(this._editorObs, originalDisplayRange, reader);
				return Math.max(maxWidth, lastValue ?? 0);
			});
		}).map((v, r) => v.read(r));

		this._previewEditorLayoutInfo = derived(this, (reader) => {
			const viewState = this._viewState.read(reader);
			if (!viewState) {
				return null;
			}

			const horizontalScrollOffset = this._editorObs.scrollLeft.read(reader);

			const editorLayout = this._editorObs.layoutInfo.read(reader);

			const previewEditorHeight = this._previewEditorObs.observeLineHeightForLine(viewState.edit.modifiedLineRange.startLineNumber).read(reader);

			const h = horizontalContentRangeInPreviewEditorToShow.read(reader);

			const previewEditorWidth = h.length;

			const hintTopLeft = this._hintTopLeft.read(reader);
			if (!hintTopLeft) {
				return null;
			}

			const margin = 10;

			const codeEditorRect = Rect.fromLeftTopWidthHeight(hintTopLeft.x + editorLayout.contentLeft + margin, hintTopLeft.y, previewEditorWidth, previewEditorHeight).withMargin(5).translateX(5 + 3 + 2);

			const codeEditorRectWithPadding = codeEditorRect.withMargin(3);
			const widgetRect = codeEditorRectWithPadding.withMargin(2, 2, 20, 2);

			//debugView(debugLogRects({ codeEditorRect, codeEditorRectWithPadding, widgetRect }, this._editor.getDomNode()!), reader);

			return {
				codeEditorRect,
				codeScrollLeft: horizontalScrollOffset,
				contentLeft: editorLayout.contentLeft,

				widgetRect,
				codeEditorRectWithPadding,

				desiredPreviewEditorScrollLeft: h.start,
				previewEditorWidth,
			};
		});

		this._originalBackgroundColor = observableFromEvent(this, this._themeService.onDidColorThemeChange, () => {
			return this._themeService.getColorTheme().getColor(originalBackgroundColor) ?? Color.transparent;
		});

		this._view = n.div({
			class: 'inline-edits-view',
			style: {
				position: 'absolute',
				overflow: 'visible',
				top: '0px',
				left: '0px',
				display: this._display,
			},
		}, [
			derived(this, reader => [this._widgetContent]),
		]).keepUpdated(this._store);

		this._register(this._editorObs.createOverlayWidget({
			domNode: this._view.element,
			position: constObservable(null),
			allowEditorOverflow: false,
			minContentWidthInPx: constObservable(0),
		}));

		this.previewEditor.setModel(this._previewTextModel);

		this._register(autorun(reader => {
			const layoutInfo = this._previewEditorLayoutInfo.read(reader);
			if (!layoutInfo) {
				return;
			}
			const editorRect = layoutInfo.codeEditorRect;

			this.previewEditor.layout({ height: editorRect.height, width: editorRect.width });
			this._widgetContent.element.style.top = `${layoutInfo.widgetRect.top}px`;
			this._widgetContent.element.style.left = `${layoutInfo.widgetRect.left}px`;
			this._widgetContent.element.style.width = `${layoutInfo.widgetRect.width}px`; // Set width to clip view zone

			//this.previewRef.element.style.width = `${layoutInfo.previewEditorWidth + HORIZONTAL_PADDING}px`;
			//this._editorContainer.element.style.borderRadius = `0 ${BORDER_RADIUS}px ${BORDER_RADIUS}px 0`;
		}));

		this._register(autorun(reader => {
			const layoutInfo = this._previewEditorLayoutInfo.read(reader);
			if (!layoutInfo) {
				return;
			}

			this._previewEditorObs.editor.setScrollLeft(layoutInfo.desiredPreviewEditorScrollLeft);
		}));

		this._updatePreviewEditor.recomputeInitiallyAndOnChange(this._store);
	}

	private readonly _decorations = derived(this, reader => {
		const viewState = this._viewState.read(reader);
		if (!viewState) { return []; }

		const hasOneInnerChange = viewState.diff.length === 1 && viewState.diff[0].innerChanges?.length === 1;
		const showEmptyDecorations = true;
		const modifiedDecorations: IModelDeltaDecoration[] = [];

		const diffWholeLineAddDecoration = ModelDecorationOptions.register({
			className: 'inlineCompletions-char-insert',
			description: 'char-insert',
			isWholeLine: true,
		});

		const diffAddDecoration = ModelDecorationOptions.register({
			className: 'inlineCompletions-char-insert',
			description: 'char-insert',
			shouldFillLineOnLineBreak: true,
		});

		const diffAddDecorationEmpty = ModelDecorationOptions.register({
			className: 'inlineCompletions-char-insert diff-range-empty',
			description: 'char-insert diff-range-empty',
		});

		for (const m of viewState.diff) {
			if (m.modified.isEmpty || m.original.isEmpty) {
				if (!m.modified.isEmpty) {
					modifiedDecorations.push({ range: m.modified.toInclusiveRange()!, options: diffWholeLineAddDecoration });
				}
			} else {
				for (const i of m.innerChanges || []) {
					// Don't show empty markers outside the line range
					if (m.modified.contains(i.modifiedRange.startLineNumber)) {
						modifiedDecorations.push({
							range: i.modifiedRange,
							options: (i.modifiedRange.isEmpty() && showEmptyDecorations && hasOneInnerChange)
								? diffAddDecorationEmpty
								: diffAddDecoration
						});
					}
				}
			}
		}

		return modifiedDecorations;
	});

	private readonly _display;

	private readonly previewRef;

	private readonly _widgetContent;

	public readonly isHovered;

	public readonly previewEditor;

	private readonly _previewEditorObs;

	private readonly _updatePreviewEditor;

	private readonly _previewEditorWidth;

	private readonly _cursorPosIfTouchesEdit;

	private readonly _hintTextPosition;


	private readonly _hintTopLeft;

	private readonly _originalDisplayRange;
	private readonly _editorMaxContentWidthInRange;

	private readonly _previewEditorLayoutInfo;
	protected readonly _originalBackgroundColor;

	private readonly _view;
}

export interface ILongDistanceHint {
	lineNumber: number;
}

export interface ILongDistanceViewState {
	hint: ILongDistanceHint;
	newTextLineCount: number;
	edit: InlineEditWithChanges;
	diff: DetailedLineRangeMapping[];
}

