import {size} from "../../gui/size"
import m, {Children, Component, Vnode} from "mithril"
import stream from "mithril/stream"
import {ExpanderButton, ExpanderPanel} from "../../gui/base/Expander"
import {formatDateWithWeekday, formatDateWithWeekdayAndYear, formatStorageSize, formatTime} from "../../misc/Formatter"
import {windowFacade, windowSizeListener} from "../../misc/WindowFacade"
import {
	FeatureType,
	InboxRuleType,
	Keys,
	MailAuthenticationStatus,
	MailFolderType,
	MailPhishingStatus,
	MailReportType,
	SpamRuleFieldType,
	SpamRuleType,
	TabIndex,
} from "../../api/common/TutanotaConstants"
import type {File as TutanotaFile, Mail} from "../../api/entities/tutanota/TypeRefs.js"
import {InfoLink, lang} from "../../misc/LanguageViewModel"
import {assertMainOrNode, isAndroidApp, isDesktop, isIOSApp} from "../../api/common/Env"
import {Dialog} from "../../gui/base/Dialog"
import {defer, DeferredObject, isNotNull, neverNull, noOp, ofClass,} from "@tutao/tutanota-utils"
import {
	allMailsAllowedInsideFolder,
	createNewContact,
	getDisplayText,
	getExistingRuleForType,
	getFolderIcon,
	getFolderName,
	getSenderOrRecipientHeading,
	getSenderOrRecipientHeadingTooltip,
	getSortedCustomFolders,
	getSortedSystemFolders,
	isTutanotaTeamMail,
} from "../model/MailUtils"
import ColumnEmptyMessageBox from "../../gui/base/ColumnEmptyMessageBox"
import type {Shortcut} from "../../misc/KeyManager"
import {keyManager} from "../../misc/KeyManager"
import {logins} from "../../api/main/LoginController"
import {Icon, progressIcon} from "../../gui/base/Icon"
import {Icons} from "../../gui/base/icons/Icons"
import {LockedError} from "../../api/common/error/RestError"
import {BootIcons} from "../../gui/base/icons/BootIcons"
import {theme} from "../../gui/theme"
import {client} from "../../misc/ClientDetector"
import {showProgressDialog} from "../../gui/dialogs/ProgressDialog"
import Badge from "../../gui/base/Badge"
import type {ButtonAttrs} from "../../gui/base/Button.js"
import {Button, ButtonColor, ButtonType} from "../../gui/base/Button.js"
import {styles} from "../../gui/styles"
import {attachDropdown, createAsyncDropdown, createDropdown, DomRectReadOnlyPolyfilled, showDropdownAtPosition} from "../../gui/base/Dropdown.js"
import {navButtonRoutes} from "../../misc/RouteChange"
import {RecipientButton} from "../../gui/base/RecipientButton"
import {EventBanner} from "./EventBanner"
import type {InlineImageReference} from "./MailGuiUtils"
import {moveMails, promptAndDeleteMails, replaceCidsWithInlineImages} from "./MailGuiUtils"
import {locator} from "../../api/main/MainLocator"
import {BannerType, InfoBanner} from "../../gui/base/InfoBanner"
import {createMoreSecondaryButtonAttrs, getCoordsOfMouseOrTouchEvent, ifAllowedTutanotaLinks} from "../../gui/base/GuiUtils"
import {copyToClipboard} from "../../misc/ClipboardUtils";
import {ContentBlockingStatus, MailViewerViewModel} from "./MailViewerViewModel"
import {getListId, listIdPart} from "../../api/common/utils/EntityUtils"
import {createEmailSenderListElement} from "../../api/entities/sys/TypeRefs.js"
import {checkApprovalStatus} from "../../misc/LoginUtils"
import {UserError} from "../../api/main/UserError"
import {showUserError} from "../../misc/ErrorHandlerImpl"
import {animations, DomMutation, scroll} from "../../gui/animation/Animations"
import {ease} from "../../gui/animation/Easing"
import {isNewMailActionAvailable} from "../../gui/nav/NavFunctions"
import {CancelledError} from "../../api/common/error/CancelledError"
import {ProgrammingError} from "../../api/common/error/ProgrammingError.js"

assertMainOrNode()
// map of inline image cid to InlineImageReference
export type InlineImages = Map<string, InlineImageReference>

const SCROLL_FACTOR = 4 / 5
const DOUBLE_TAP_TIME_MS = 350

type MailAddressAndName = {
	name: string
	address: string
}

export type MailViewerAttrs = {
	viewModel: MailViewerViewModel
}

/**
 * The MailViewer displays a mail. The mail body is loaded asynchronously.
 *
 * The viewer has a longer lifecycle than viewModel so we need to be careful about the state.
 */
export class MailViewer implements Component<MailViewerAttrs> {

	/** it is set after we measured mail body element */
	private bodyLineHeight: number | null = null

	private mailHeaderDialog: Dialog
	private mailHeaderInfo: string
	private isScaling = true
	private readonly filesExpanded = stream<boolean>(false)

	private lastBodyTouchEndTime = 0
	private lastTouchStart = {
		x: 0,
		y: 0,
		time: Date.now(),
	}

	/**
	 * Delay the display of the progress spinner in main body view for a short time to suppress it when we are switching between cached emails
	 * and we are just sanitizing
	 */
	private delayProgressSpinner = true

	private readonly resizeListener: windowSizeListener

	private viewModel!: MailViewerViewModel

	private readonly detailsExpanded = stream<boolean>(false)

	private readonly shortcuts: Array<Shortcut>

	private scrollAnimation: Promise<void> | null = null
	private scrollDom: HTMLElement | null = null

	private domBodyDeferred: DeferredObject<HTMLElement> = defer()
	private domBody: HTMLElement | null = null

	private shadowDomRoot: ShadowRoot | null = null
	private currentlyRenderedMailBody: DocumentFragment | null = null

	private loadAllListener = stream()

	constructor(vnode: Vnode<MailViewerAttrs>) {
		this.setViewModel(vnode.attrs.viewModel)

		const closeAction = () => this.mailHeaderDialog.close()
		this.mailHeaderInfo = ""
		this.mailHeaderDialog = Dialog.largeDialog({
			right: [
				{
					label: "ok_action",
					click: closeAction,
					type: ButtonType.Secondary,
				},
			],
			middle: () => lang.get("mailHeaders_title"),
		}, {
			view: () => {
				return m(".white-space-pre.pt.pb.selectable", this.mailHeaderInfo)
			},
		}).addShortcut({
			key: Keys.ESC,
			exec: closeAction,
			help: "close_alt",
		}).setCloseHandler(closeAction)

		this.resizeListener = () => this.domBodyDeferred.promise.then(dom => this.updateLineHeight(dom))

		this.shortcuts = this.setupShortcuts()
	}

	oncreate() {
		keyManager.registerShortcuts(this.shortcuts)
		windowFacade.addResizeListener(this.resizeListener)
	}

	onremove() {
		windowFacade.removeResizeListener(this.resizeListener)
		this.clearDomBody()
		keyManager.unregisterShortcuts(this.shortcuts)
	}

	private setViewModel(viewModel: MailViewerViewModel) {
		// Figuring out whether we have a new email assigned.
		const oldViewModel = this.viewModel
		this.viewModel = viewModel
		if (this.viewModel !== oldViewModel) {
			this.loadAllListener.end(true)
			this.loadAllListener = this.viewModel.loadCompleteNotification.map(async () => {
				// streams are pretty much synchronous, so we could be in the middle of a redraw here and mithril does not just schedule another redraw, it
				// will error out so before calling m.redraw.sync() we want to make sure that we are not inside a redraw by just scheduling a microtask with
				// this simple await.
				await Promise.resolve()
				// Wait for mail body to be redrawn before replacing images
				m.redraw.sync()
				await this.replaceInlineImages()
				m.redraw()
			})

			// Reset scaling status if it's a new email.
			this.isScaling = true
			this.viewModel.loadAll()

			this.delayProgressSpinner = true
			setTimeout(() => {
				this.delayProgressSpinner = false
				m.redraw()
			}, 50)
		}
	}

	view(vnode: Vnode<MailViewerAttrs>): Children {
		const dateTime = formatDateWithWeekday(this.viewModel.mail.receivedDate) + " • " + formatTime(this.viewModel.mail.receivedDate)
		const dateTimeFull = formatDateWithWeekdayAndYear(this.viewModel.mail.receivedDate) + " • " + formatTime(this.viewModel.mail.receivedDate)

		return [
			m(
				"#mail-viewer.fill-absolute" + (client.isMobileDevice() ? ".scroll-no-overlay.overflow-x-hidden" : ".flex.flex-column"),
				[
					m(".header.plr-l.mlr-safe-inset", [
						m(".flex-space-between.button-min-height", [
							// the natural height may vary in browsers (Firefox), so set it to button height here to make it similar to the MultiMailViewer
							m(".flex.flex-column-reverse", [
								this.detailsExpanded()
									? m("small.flex.text-break", lang.get("from_label"))
									: m(
										".small.flex.text-break.selectable.badge-line-height.flex-wrap.pt-s",
										{
											title: getSenderOrRecipientHeadingTooltip(this.viewModel.mail),
										},
										[this.tutaoBadge(), getSenderOrRecipientHeading(this.viewModel.mail, false)],
									),
								this.viewModel.getFolderText()
									? m(
										"small.b.flex.pt",
										{
											style: {
												color: theme.navigation_button,
											},
										},
										this.viewModel.getFolderText(),
									)
									: null,
							]),
							!this.viewModel.isAnnouncement() && styles.isUsingBottomNavigation()
								? null
								: m(".pt-0", this.renderShowMoreButton()),
						]),
						m(
							".mb-m",
							m(ExpanderPanel, {
									expanded: this.detailsExpanded(),
								},
								this.renderDetails({bubbleMenuWidth: 300}),
							),
						),
						m(".subject-actions.flex-space-between.flex-wrap.mt-xs", [
							m(".left.flex-grow-shrink-150", [
								m(
									".subject.text-break.selectable",
									{
										"aria-label": lang.get("subject_label") + ", " + (this.viewModel.getSubject() || ""),
									},
									this.viewModel.getSubject() || "",
								),
								m(
									".flex.items-center.content-accent-fg.svg-content-accent-fg" + (this.viewModel.isConfidential() ? ".ml-negative-xs" : ""),
									{
										// Orca refuses to read ut unless it's not focusable
										tabindex: TabIndex.Default,
										"aria-label": lang.get(this.viewModel.isConfidential() ? "confidential_action" : "nonConfidential_action") + ", " + dateTime,
									},
									[
										this.viewModel.isConfidential()
											? m(Icon, {
												icon: Icons.Lock,
												style: {
													fill: theme.content_fg,
												},
											})
											: null,
										m("small.date.mt-xs.content-fg.selectable",
											[
												m("span.noprint", dateTime), // show the short date when viewing
												m("span.noscreen", dateTimeFull), // show the date with year when printing
											]
										),
										m(".flex-grow"),
										m(
											".flex.flex-column-reverse",
											!this.viewModel.isAnnouncement() && styles.isUsingBottomNavigation()
												? m(".pt-m", this.renderShowMoreButton())
												: null,
										),
									],
								),
							]),
							styles.isUsingBottomNavigation() ? null : this.actionButtons(),
						]),
						styles.isUsingBottomNavigation() ? this.actionButtons() : null,
						this.renderConnectionLostBanner(),
						this.renderEventBanner(),
						this.renderAttachments(),
						this.renderBanners(this.viewModel.mail),
					]),
					m(
						".flex-grow.mlr-safe-inset.scroll-x.plr-l.pb-floating.pt" +
						(client.isMobileDevice() ? "" : ".scroll-no-overlay") +
						(this.viewModel.isContrastFixNeeded() ? ".bg-white.content-black" : " "),
						{
							oncreate: (vnode) => {
								this.scrollDom = vnode.dom as HTMLElement
							},
						},
						this.renderMailBodySection(),
					),
				],
			),
		]
	}

	onbeforeupdate(vnode: Vnode<MailViewerAttrs>): boolean | void {
		// Setting viewModel here to have viewModel that we will use for render already and be able to make a decision
		// about skipping rendering
		this.setViewModel(vnode.attrs.viewModel)
		// We skip rendering progress indicator when switching between emails.
		// However if we already loaded the mail then we can just render it.
		const shouldSkipRender = this.viewModel.isLoading() && this.delayProgressSpinner
		return !shouldSkipRender
	}

	private renderMailBodySection(): Children {
		if (this.viewModel.didErrorsOccur()) {
			return m(ColumnEmptyMessageBox, {
				message: "corrupted_msg",
				icon: Icons.Warning,
				color: theme.content_message_bg,
			})
		}

		const sanitizedMailBody = this.viewModel.getSanitizedMailBody()

		// Do not render progress spinner or mail body while we are animating.
		if (this.viewModel.shouldDelayRendering()) {
			return null
		} else if (sanitizedMailBody != null) {
			return this.renderMailBody(sanitizedMailBody)
		} else if (this.viewModel.isLoading()) {
			return this.renderLoadingIcon()
		} else {
			// The body failed to load, just show blank body because there is a banner
			return null
		}
	}

	private renderMailBody(sanitizedMailBody: DocumentFragment): Children {
		return m("#mail-body",
			{
				// key to avoid mithril reusing the dom element when it should switch the rendering the loading spinner
				key: "mailBody",
				oncreate: vnode => {
					const dom = vnode.dom as HTMLElement
					this.setDomBody(dom)
					this.updateLineHeight(dom)
					this.rescale(false)
					this.renderShadowMailBody(sanitizedMailBody)
				},
				onupdate: vnode => {
					const dom = vnode.dom as HTMLElement
					this.setDomBody(dom)

					// Only measure and update line height once.
					// BUT we need to do in from onupdate too if we swap mailViewer but mithril does not realize
					// that it's a different vnode so oncreate might not be called.
					if (!this.bodyLineHeight) {
						this.updateLineHeight(vnode.dom as HTMLElement)
					}

					this.rescale(false)
					if (this.currentlyRenderedMailBody !== sanitizedMailBody) this.renderShadowMailBody(sanitizedMailBody)
				},
				onbeforeremove: () => {
					// Clear dom body in case there will be a new one, we want promise to be up-to-date
					this.clearDomBody()
				},
				onsubmit: (event: Event) => {
					// use the default confirm dialog here because the submit can not be done async
					if (!confirm(lang.get("reallySubmitContent_msg"))) {
						event.preventDefault()
					}
				},
				style: {
					"line-height": this.bodyLineHeight ? this.bodyLineHeight.toString() : size.line_height,
					"transform-origin": "top left",
				},
			}
		)
	}

	/**
	 * manually wrap and style a mail body to display correctly inside a shadow root
	 * @param sanitizedMailBody the mail body to display
	 * @private
	 */
	private renderShadowMailBody(sanitizedMailBody: DocumentFragment) {
		assertNonNull(this.shadowDomRoot)
		while (this.shadowDomRoot.firstChild) {
			this.shadowDomRoot.firstChild.remove()
		}
		const wrapNode = document.createElement("div")
		wrapNode.className = "selectable touch-callout break-word-links" + (client.isMobileDevice() ? " break-pre" : "")
		wrapNode.style.lineHeight = String(this.bodyLineHeight ? this.bodyLineHeight.toString() : size.line_height)
		wrapNode.style.transformOrigin = "top left"
		wrapNode.appendChild(sanitizedMailBody.cloneNode(true))
		if (client.isMobileDevice()) {
			wrapNode.addEventListener("touchstart", (event) => {
				const touch = event.touches[0]
				this.lastTouchStart.x = touch.clientX
				this.lastTouchStart.y = touch.clientY
				this.lastTouchStart.time = Date.now()
			})
			wrapNode.addEventListener("touchend", (event) => {
				const href = (event.target as Element | null)?.closest("a")?.getAttribute("href") ?? null
				this.handleDoubleTap(
					event,
					e => this.handleAnchorClick(e, href, true),
					() => this.rescale(true),
				)
			})
		} else {
			wrapNode.addEventListener("click", (event) => {
				const href = (event.target as Element | null)?.closest("a")?.getAttribute("href") ?? null
				this.handleAnchorClick(event, href, false)
			})
		}
		this.shadowDomRoot.appendChild(styles.getStyleSheetElement("main"))
		this.shadowDomRoot.appendChild(wrapNode)
		this.currentlyRenderedMailBody = sanitizedMailBody
	}

	private clearDomBody() {
		this.domBodyDeferred = defer()
		this.domBody = null
		this.shadowDomRoot = null
	}

	private setDomBody(dom: HTMLElement) {
		if (dom !== this.domBody || this.shadowDomRoot == null) {
			// If the dom element hasn't been created anew in onupdate
			// then trying to create a new shadow root on the same node will cause an error
			this.shadowDomRoot = dom.attachShadow({mode: "open"})

			// Allow forms inside of mail bodies to be filled out without resulting in keystrokes being interpreted as shortcuts
			this.shadowDomRoot.getRootNode().addEventListener("keydown", (event: Event) => event.stopPropagation())
		}

		this.domBodyDeferred.resolve(dom)
		this.domBody = dom
	}

	private renderLoadingIcon(): Children {
		return m(".progress-panel.flex-v-center.items-center",
			{
				key: "loadingIcon",
				style: {
					height: "200px",
				},
			},
			[progressIcon(), m("small", lang.get("loading_msg"))],
		)
	}

	private renderBanners(mail: Mail): Children {
		return [
			this.renderPhishingWarning() || this.renderHardAuthenticationFailWarning(mail) || this.renderSoftAuthenticationFailWarning(mail),
			this.renderExternalContentBanner(),
			m("hr.hr.mt-xs"),
		].filter(Boolean)
	}

	private renderConnectionLostBanner(): Children {
		// If the mail body failed to load, then we show a message in the main column
		// If the mail body did load but not everything else, we show the message here
		if (this.viewModel.isConnectionLost()) {
			return m(InfoBanner, {
				message: "mailPartsNotLoaded_msg",
				icon: Icons.Warning,
				buttons: [
					{
						label: "retry_action",
						click: () => this.viewModel.loadAll()
					}
				]
			})
		} else {
			return null
		}
	}

	private renderEventBanner(): Children {
		const event = this.viewModel.getCalendarEventAttachment()
		return event
			? m(EventBanner, {
				event: event.event,
				method: event.method,
				recipient: event.recipient,
				mail: this.viewModel.mail,
			})
			: null
	}

	private renderShowMoreButton() {
		return m(ExpanderButton, {
			label: "showMore_action",
			expanded: this.detailsExpanded(),
			onExpandedChange: this.detailsExpanded,
		})
	}

	private renderDetails({bubbleMenuWidth}: {bubbleMenuWidth: number}): Children {
		const envelopeSender = this.viewModel.getDifferentEnvelopeSender()
		return [
			m(RecipientButton, {
				label: getDisplayText(this.viewModel.getSender().name, this.viewModel.getSender().address, false),
				click: createAsyncDropdown({
					lazyButtons: () => this.createMailAddressContextButtons({
						mailAddress: this.viewModel.getSender(),
						defaultInboxRuleField: InboxRuleType.FROM_EQUALS
					}), width: bubbleMenuWidth
				}),
			}),
			envelopeSender
				? [
					m(".small", lang.get("sender_label")),
					m(RecipientButton, {
						label: getDisplayText("", envelopeSender, false),
						click: createAsyncDropdown({
							lazyButtons: async () => {
								const childElements = [
									{
										info: lang.get("envelopeSenderInfo_msg"),
										center: false,
										bold: false,
									},
									{
										info: envelopeSender,
										center: true,
										bold: true,
									},
								]
								const contextButtons = await this.createMailAddressContextButtons(
									{
										mailAddress: {
											address: envelopeSender,
											name: "",
										},
										defaultInboxRuleField: InboxRuleType.FROM_EQUALS,
										createContact: false
									},
								)
								return [...childElements, ...contextButtons]
							}, width: bubbleMenuWidth
						}),
					}),
				]
				: null,
			this.viewModel.getToRecipients().length
				? [
					m(".small", lang.get("to_label")),
					m(
						".flex-start.flex-wrap",
						this.viewModel.getToRecipients().map(recipient =>
							m(RecipientButton, {
								label: getDisplayText(recipient.name, recipient.address, false),
								click: createAsyncDropdown(
									{
										lazyButtons: () => this.createMailAddressContextButtons({
											mailAddress: recipient,
											defaultInboxRuleField: InboxRuleType.RECIPIENT_TO_EQUALS
										}), width: bubbleMenuWidth
									},
								),
								// To wrap text inside flex container, we need to allow element to shrink and pick own width
								style: {
									flex: "0 1 auto",
								},
							}),
						),
					),
				]
				: null,
			this.viewModel.getCcRecipients().length
				? [
					m(".small", lang.get("cc_label")),
					m(
						".flex-start.flex-wrap",
						this.viewModel.getCcRecipients().map(recipient =>
							m(RecipientButton, {
								label: getDisplayText(recipient.name, recipient.address, false),
								click: createAsyncDropdown(
									{
										lazyButtons: () => this.createMailAddressContextButtons({
											mailAddress: recipient,
											defaultInboxRuleField: InboxRuleType.RECIPIENT_CC_EQUALS
										}), width: bubbleMenuWidth
									},
								),
								style: {
									flex: "0 1 auto",
								},
							}),
						),
					),
				]
				: null,
			this.viewModel.getBccRecipients().length
				? [
					m(".small", lang.get("bcc_label")),
					m(
						".flex-start.flex-wrap",
						this.viewModel.getBccRecipients().map(recipient =>
							m(RecipientButton, {
								label: getDisplayText(recipient.name, recipient.address, false),
								click: createAsyncDropdown(
									{
										lazyButtons: () => this.createMailAddressContextButtons({
											mailAddress: recipient,
											defaultInboxRuleField: InboxRuleType.RECIPIENT_BCC_EQUALS
										}), width: bubbleMenuWidth
									},
								),
								style: {
									flex: "0 1 auto",
								},
							}),
						),
					),
				]
				: null,
			this.viewModel.getReplyTos().length
				? [
					m(".small", lang.get("replyTo_label")),
					m(
						".flex-start.flex-wrap",
						this.viewModel.getReplyTos().map(recipient =>
							m(RecipientButton, {
								label: getDisplayText(recipient.name, recipient.address, false),
								click: createAsyncDropdown({
									lazyButtons: () => this.createMailAddressContextButtons({
										mailAddress: recipient,
										defaultInboxRuleField: null
									}), width: bubbleMenuWidth
								}),
								style: {
									flex: "0 1 auto",
								},
							}),
						),
					),
				]
				: null,
		]
	}

	async replaceInlineImages() {
		const loadedInlineImages = await this.viewModel.getLoadedInlineImages()
		const domBody = await this.domBodyDeferred.promise
		replaceCidsWithInlineImages(domBody, loadedInlineImages, (cid, event) => {
			const inlineAttachment = this.viewModel.getAttachments().find(attachment => attachment.cid === cid)

			if (inlineAttachment) {
				const coords = getCoordsOfMouseOrTouchEvent(event)
				showDropdownAtPosition(
					[
						{
							label: "download_action",
							click: () => this.viewModel.downloadAndOpenAttachment(inlineAttachment, false),
							type: ButtonType.Dropdown,
						},
						{
							label: "open_action",
							click: () => this.viewModel.downloadAndOpenAttachment(inlineAttachment, true),
							type: ButtonType.Dropdown,
						},
					],
					coords.x,
					coords.y,
				)
			}
		})
	}

	private unsubscribe(): Promise<void> {
		return showProgressDialog("pleaseWait_msg", this.viewModel.unsubscribe())
			.then(success => {
				if (success) {
					return Dialog.message("unsubscribeSuccessful_msg")
				}
			})
			.catch(e => {
				if (e instanceof LockedError) {
					return Dialog.message("operationStillActive_msg")
				} else {
					return Dialog.message("unsubscribeFailed_msg")
				}
			})
	}

	private actionButtons(): Children {
		const actions: Children = []
		const colors = ButtonColor.Content
		const moveButton = m(Button, {
			label: "move_action",
			icon: () => Icons.Folder,
			colors,
			click: createAsyncDropdown({
					lazyButtons: () => {
						return this.viewModel.mailModel.getMailboxFolders(this.viewModel.mail).then(folders => {
								const filteredFolders = folders.filter(f => f.mails !== listIdPart(this.viewModel.getMailId()))
								const targetFolders = getSortedSystemFolders(filteredFolders).concat(getSortedCustomFolders(filteredFolders))
								return targetFolders.filter(f => allMailsAllowedInsideFolder([this.viewModel.mail], f)).map(f => {
									return {
										label: () => getFolderName(f),
										click: () => moveMails({
											mailModel: this.viewModel.mailModel,
											mails: [this.viewModel.mail],
											targetMailFolder: f
										}),
										icon: getFolderIcon(f),
										type: ButtonType.Dropdown,
									}
								})
							}
						)
					}
				},
			),
		})

		if (this.viewModel.isDraftMail()) {
			actions.push(
				m(Button, {
					label: "edit_action",
					click: () => this.editDraft(),
					icon: () => Icons.Edit,
					colors,
				}),
			)
			actions.push(moveButton)
		} else {
			if (!this.viewModel.isAnnouncement()) {
				actions.push(
					m(Button, {
						label: "reply_action",
						click: () => this.viewModel.reply(false),
						icon: () => Icons.Reply,
						colors,
					}),
				)

				if (this.viewModel.canReplyAll()) {
					actions.push(
						m(Button, {
							label: "replyAll_action",
							click: () => this.viewModel.reply(true),
							icon: () => Icons.ReplyAll,
							colors,
						}),
					)
				}

				if (this.viewModel.canForwardOrMove()) {
					actions.push(
						m(Button, {
							label: "forward_action",
							click: () => this.viewModel.forward()
											 .catch(ofClass(UserError, showUserError)),
							icon: () => Icons.Forward,
							colors,
						}),
					)
					actions.push(moveButton)
				} else if (this.viewModel.canAssignMails()) {
					actions.push(this.createAssignActionButton())
				}
			}
		}

		actions.push(
			m(Button, {
				label: "delete_action",
				click: () => {
					promptAndDeleteMails(this.viewModel.mailModel, [this.viewModel.mail], noOp)
				},
				icon: () => Icons.Trash,
				colors,
			}),
		)

		if (!this.viewModel.isDraftMail()) {
			actions.push(
				m(Button, {
					label: "more_label",
					icon: () => Icons.More,
					colors,
					click: createDropdown({
						lazyButtons: () => {
							const moreButtons: Array<ButtonAttrs> = []

							if (this.viewModel.isUnread()) {
								moreButtons.push({
									label: "markRead_action",
									click: () => this.viewModel.setUnread(false),
									icon: () => Icons.Eye,
									type: ButtonType.Dropdown,
								})
							} else {
								moreButtons.push({
									label: "markUnread_action",
									click: () => this.viewModel.setUnread(true),
									icon: () => Icons.NoEye,
									type: ButtonType.Dropdown,
								})
							}

							if (!this.viewModel.isAnnouncement() && !client.isMobileDevice() && !logins.isEnabled(FeatureType.DisableMailExport)) {
								moreButtons.push({
									label: "export_action",
									click: () => showProgressDialog("pleaseWait_msg", this.viewModel.exportMail()),
									icon: () => Icons.Export,
									type: ButtonType.Dropdown,
								})
							}

							if (!client.isMobileDevice() && !logins.isEnabled(FeatureType.DisableMailExport) && typeof window.print === "function") {
								moreButtons.push({
									label: "print_action",
									click: () => window.print(),
									icon: () => Icons.Print,
									type: ButtonType.Dropdown,
								})
							}

							if (this.viewModel.isListUnsubscribe()) {
								moreButtons.push({
									label: "unsubscribe_action",
									click: () => this.unsubscribe(),
									icon: () => Icons.Cancel,
									type: ButtonType.Dropdown,
								})
							}

							if (logins.isInternalUserLoggedIn()) {
								moreButtons.push({
									label: "showHeaders_action",
									click: () => this.showHeaders(),
									icon: () => Icons.ListUnordered,
									type: ButtonType.Dropdown,
								})
							}

							if (this.viewModel.getPhishingStatus() === MailPhishingStatus.UNKNOWN && !this.viewModel.isTutanotaTeamMail() && logins.isInternalUserLoggedIn()) {
								moreButtons.push({
									label: "reportEmail_action",
									click: () => this.reportMail(),
									icon: () => Icons.Warning,
									type: ButtonType.Dropdown,
								})
							}

							if (locator.search.indexingSupported && this.viewModel.isShowingExternalContent()) {
								moreButtons.push({
									label: "disallowExternalContent_action",
									click: async () => {
										await this.setContentBlockingStatus(ContentBlockingStatus.Block)
									},
									icon: () => Icons.Picture,
									type: ButtonType.Dropdown,
								})
							}

							if (locator.search.indexingSupported && this.viewModel.isBlockingExternalImages()) {
								moreButtons.push({
									label: "showImages_action",
									click: async () => {
										await this.setContentBlockingStatus(ContentBlockingStatus.Show)
									},
									icon: () => Icons.Picture,
									type: ButtonType.Dropdown,
								})
							}

							return moreButtons
						}, width: 300
					}),
				}),
			)
		}

		return m(".action-bar.flex-end.items-center.mr-negative-s", actions)
	}


	private reportMail() {
		const sendReport = (reportType: MailReportType) => {
			this.viewModel.reportMail(reportType)
				.catch(ofClass(LockedError, () => Dialog.message("operationStillActive_msg")))
				.finally(m.redraw)
		}

		const dialog = Dialog.showActionDialog({
			title: lang.get("reportEmail_action"),
			child: () =>
				m(
					".flex.col.mt-m",
					{
						// So that space below buttons doesn't look huge
						style: {
							marginBottom: "-10px",
						},
					},
					[
						m("div", lang.get("phishingReport_msg")),
						ifAllowedTutanotaLinks(InfoLink.Phishing, link =>
							m(
								"a.mt-s",
								{
									href: link,
									target: "_blank",
								},
								lang.get("whatIsPhishing_msg"),
							),
						),
						m(".flex-wrap.flex-end", [
							m(Button, {
								label: "reportPhishing_action",
								click: () => {
									sendReport(MailReportType.PHISHING)
									dialog.close()
								},
								type: ButtonType.Secondary,
							}),
							m(Button, {
								label: "reportSpam_action",
								click: () => {
									sendReport(MailReportType.SPAM)
									dialog.close()
								},
								type: ButtonType.Secondary,
							}),
						]),
					],
				),
			okAction: null,
		})
	}

	private createAssignActionButton(): Children {
		const makeButtons = async (): Promise<ButtonAttrs[]> => {
			const assignmentGroupInfos = await this.viewModel.getAssignmentGroupInfos()

			return assignmentGroupInfos.map(userOrMailGroupInfo => {
				return {
					label: () => getDisplayText(userOrMailGroupInfo.name, neverNull(userOrMailGroupInfo.mailAddress), true),
					icon: () => BootIcons.Contacts,
					type: ButtonType.Dropdown,
					click: () => this.viewModel.assignMail(userOrMailGroupInfo),
				} as ButtonAttrs
			})
		}

		return m(Button, {
			label: "forward_action",
			icon: () => Icons.Forward,
			colors: ButtonColor.Content,
			click: createAsyncDropdown({
				width: 250,
				lazyButtons: makeButtons
			})
		})
	}


	private renderAttachments(): Children {
		// Show a loading symbol if we are loading attachments
		if (this.viewModel.isLoadingAttachments() && !this.viewModel.isConnectionLost()) {
			return m(".flex", [m(".flex-v-center.pl-button", progressIcon()), m(".small.flex-v-center.plr.button-height", lang.get("loading_msg"))])
		} else {
			const attachments = this.viewModel.getNonInlineAttachments()
			const attachmentCount = attachments.length

			// Do nothing if we have no attachments
			if (attachmentCount === 0) {
				return null
			}

			// Get the total size of the attachments
			let totalAttachmentSize = 0
			attachments.forEach(attachment => totalAttachmentSize += Number(attachment.size))

			return [
				m(".flex.ml-negative-bubble.flex-space-between", [
					attachmentCount === 1
						// If we have exactly one attachment, just show the attachment
						? this.renderAttachmentContainer(attachments)

						// Otherwise, we show the number of attachments and its total size along with a show all button
						: [
							m(".flex.b.center-vertically.pl-s",
								lang.get("attachmentAmount_label", {"{amount}": attachmentCount + ""}) + ` (${formatStorageSize(totalAttachmentSize)})`
							),
							m(".flex",
								m(ExpanderButton, {
									style: {paddingTop: "0px"},
									label: "showAll_action",
									expanded: this.filesExpanded(),
									onExpandedChange: this.filesExpanded,
								})
							)
						],
				]),

				// if we have more than one attachment, list them here in this expander panel
				attachments.length > 1 ? m(ExpanderPanel, {
						expanded: this.filesExpanded(),
					},
					m(".ml-negative-bubble.flex-wrap", [
						this.renderAttachmentContainer(attachments),
						this.renderDownloadAllButton()
					])
				) : null,
			]
		}
	}

	private renderAttachmentContainer(attachments: TutanotaFile[]): Children {
		return m("", attachments.map(attachment => this.renderAttachmentButton(attachment))) // wrap attachments in a div to ensure buttons after the list don't get placed weirdly
	}

	private renderAttachmentButton(attachment: TutanotaFile): Children {
		if (isAndroidApp() || isDesktop()) {
			return m(Button,
				attachDropdown(
					{
						mainButtonAttrs: {
							label: () => attachment.name,
							icon: () => Icons.Attachment,
							type: ButtonType.Bubble,
							staticRightText: `(${formatStorageSize(Number(attachment.size))})`
						},
						childAttrs: () => [
							{
								label: "open_action",
								click: () => this.viewModel.downloadAndOpenAttachment(attachment, true),
								type: ButtonType.Dropdown
							},
							{
								label: "download_action",
								click: () => this.viewModel.downloadAndOpenAttachment(attachment, false),
								type: ButtonType.Dropdown
							},
						],
						showDropdown: () => true,
						width: 200,
						overrideOrigin: (originalOrigin) => {
							// Bubble buttons use border so dropdown is misaligned by default
							return new DomRectReadOnlyPolyfilled(
								originalOrigin.left + size.bubble_border_width,
								originalOrigin.top,
								originalOrigin.width,
								originalOrigin.height
							)
						}
					}
				)
			)
		} else {
			return m(Button, {
				label: () => attachment.name,
				icon: () => Icons.Attachment,
				click: () => this.viewModel.downloadAndOpenAttachment(attachment, true),
				type: ButtonType.Bubble,
				staticRightText: `(${formatStorageSize(Number(attachment.size))})`
			})
		}
	}

	private renderDownloadAllButton(): Children {
		return !isIOSApp() && this.viewModel.getNonInlineAttachments().length > 1
			? m(Button, {
				label: "saveAll_action",
				type: ButtonType.Secondary,
				click: () => showProgressDialog("pleaseWait_msg", this.viewModel.downloadAll()),
			}) : null
	}

	private tutaoBadge(): Vnode<any> | null {
		return isTutanotaTeamMail(this.viewModel.mail)
			? m(
				Badge,
				{
					classes: ".mr-s",
				},
				"Tutanota Team",
			)
			: null
	}


	private rescale(animate: boolean) {
		const child = this.domBody
		if (!client.isMobileDevice() || !child) {
			return
		}
		const containerWidth = child.offsetWidth

		if (!this.isScaling || containerWidth > child.scrollWidth) {
			child.style.transform = ""
			child.style.marginBottom = ""
		} else {
			const width = child.scrollWidth
			const scale = containerWidth / width
			const heightDiff = child.scrollHeight - child.scrollHeight * scale
			child.style.transform = `scale(${scale})`
			child.style.marginBottom = `${-heightDiff}px`
		}

		child.style.transition = animate ? "transform 200ms ease-in-out" : ""
		// ios 15 bug: transformOrigin magically disappears so we ensure that it's always set
		child.style.transformOrigin = "top left"
	}

	private setupShortcuts(): Array<Shortcut> {
		const userController = logins.getUserController()
		const shortcuts: Shortcut[] = [
			{
				key: Keys.E,
				enabled: () => this.viewModel.isDraftMail(),
				exec: () => {
					this.editDraft()
				},
				help: "editMail_action",
			},
			{
				key: Keys.H,
				enabled: () => !this.viewModel.isDraftMail(),
				exec: () => this.showHeaders(),
				help: "showHeaders_action",
			},
			{
				key: Keys.R,
				exec: () => {
					this.viewModel.reply(false)
				},
				enabled: () => !this.viewModel.isDraftMail(),
				help: "reply_action",
			},
			{
				key: Keys.R,
				shift: true,
				exec: () => {
					this.viewModel.reply(true)
				},
				enabled: () => !this.viewModel.isDraftMail(),
				help: "replyAll_action",
			},
			{
				key: Keys.PAGE_UP,
				exec: () => this.scrollUp(),
				help: "scrollUp_action",
			},
			{
				key: Keys.PAGE_DOWN,
				exec: () => this.scrollDown(),
				help: "scrollDown_action",
			},
			{
				key: Keys.HOME,
				exec: () => this.scrollToTop(),
				help: "scrollToTop_action",
			},
			{
				key: Keys.END,
				exec: () => this.scrollToBottom(),
				help: "scrollToBottom_action",
			},
		]

		if (userController.isInternalUser()) {
			shortcuts.push({
				key: Keys.F,
				shift: true,
				enabled: () => !this.viewModel.isDraftMail(),
				exec: () => {
					this.viewModel.forward()
						.catch(ofClass(UserError, showUserError))
				},
				help: "forward_action",
			})
		}

		return shortcuts
	}

	private updateLineHeight(dom: HTMLElement) {
		const width = dom.offsetWidth

		if (width > 900) {
			this.bodyLineHeight = size.line_height_l
		} else if (width > 600) {
			this.bodyLineHeight = size.line_height_m
		} else {
			this.bodyLineHeight = size.line_height
		}

		dom.style.lineHeight = String(this.bodyLineHeight)
	}

	private async createMailAddressContextButtons(args: {
		mailAddress: MailAddressAndName,
		defaultInboxRuleField: InboxRuleType | null,
		createContact?: boolean,
	}): Promise<Array<ButtonAttrs>> {

		const {
			mailAddress,
			defaultInboxRuleField,
			createContact = true
		} = args

		const buttons = [] as Array<ButtonAttrs>

		buttons.push({
				label: "copy_action",
				type: ButtonType.Secondary,
				click: () => copyToClipboard(mailAddress.address),
			}
		)

		if (logins.getUserController().isInternalUser()) {
			//searching for contacts will never resolve if the user has not logged in online
			if (createContact && !logins.isEnabled(FeatureType.DisableContacts) && logins.isFullyLoggedIn()) {
				const contact = await this.viewModel.contactModel.searchForContact(mailAddress.address)
				if (contact) {
					buttons.push({
						label: "showContact_action",
						click: () => {
							navButtonRoutes.contactsUrl = `/contact/${neverNull(contact)._id[0]}/${neverNull(contact)._id[1]}`
							m.route.set(navButtonRoutes.contactsUrl + location.hash)
						},
						type: ButtonType.Secondary,
					})
				} else {
					buttons.push({
						label: "createContact_action",
						click: () => {
							this.viewModel.contactModel.contactListId().then(contactListId => {
								import("../../contacts/ContactEditor").then(({ContactEditor}) => {
									const contact = createNewContact(logins.getUserController().user, mailAddress.address, mailAddress.name)
									new ContactEditor(this.viewModel.entityClient, contact, contactListId ?? undefined).show()
								})
							})
						},
						type: ButtonType.Secondary,
					})
				}
			}

			if (defaultInboxRuleField && !logins.isEnabled(FeatureType.InternalCommunication)) {
				const rule = getExistingRuleForType(logins.getUserController().props, mailAddress.address.trim().toLowerCase(), defaultInboxRuleField)
				buttons.push({
					label: rule ? "editInboxRule_action" : "addInboxRule_action",
					click: async () => {
						const mailboxDetails = await this.viewModel.mailModel.getMailboxDetailsForMail(this.viewModel.mail)
						const {show, createInboxRuleTemplate} = await import("../../settings/AddInboxRuleDialog")
						const newRule = rule ?? createInboxRuleTemplate(defaultInboxRuleField, mailAddress.address.trim().toLowerCase())
						show(mailboxDetails, newRule)
					},
					type: ButtonType.Secondary,
				})
			}

			if (this.viewModel.canCreateSpamRule()) {
				buttons.push({
					label: "addSpamRule_action",
					click: () => this.addSpamRule(defaultInboxRuleField, mailAddress.address),
					type: ButtonType.Secondary,
				})
			}
		}

		return buttons
	}

	private showHeaders() {
		if (!this.mailHeaderDialog.visible) {
			this.viewModel.getHeaders().then(headers => {
				this.mailHeaderInfo = headers ?? lang.get("noMailHeadersInfo_msg")
				this.mailHeaderDialog.show()
			})
		}
	}

	private handleDoubleTap(e: TouchEvent, singleClickAction: (e: TouchEvent) => void, doubleClickAction: (e: TouchEvent) => void) {
		const lastClick = this.lastBodyTouchEndTime
		const now = Date.now()
		const touch = e.changedTouches[0]

		// If there are no touches or it's not cancellable event (e.g. scroll) or more than certain time has passed or finger moved too
		// much then do nothing
		if (
			!touch ||
			!e.cancelable ||
			Date.now() - this.lastTouchStart.time > DOUBLE_TAP_TIME_MS ||
			touch.clientX - this.lastTouchStart.x > 40 ||
			touch.clientY - this.lastTouchStart.y > 40
		) {
			return
		}

		e.preventDefault()

		if (now - lastClick < DOUBLE_TAP_TIME_MS) {
			this.isScaling = !this.isScaling
			this.lastBodyTouchEndTime = 0
			doubleClickAction(e)
		} else {
			setTimeout(() => {
				if (this.lastBodyTouchEndTime === now) {
					singleClickAction(e)
				}
			}, DOUBLE_TAP_TIME_MS)
		}

		this.lastBodyTouchEndTime = now
	}

	private renderPhishingWarning(): Children | null {
		if (this.viewModel.isMailSuspicious()) {
			return m(InfoBanner, {
				message: "phishingMessageBody_msg",
				icon: Icons.Warning,
				type: BannerType.Warning,
				helpLink: InfoLink.Phishing,
				buttons: [
					{
						label: "markAsNotPhishing_action",
						click: () => this.viewModel.markAsNotPhishing().then(() => m.redraw()),
					},
				],
			})
		}
	}

	private renderHardAuthenticationFailWarning(mail: Mail): Children | null {
		if (!this.viewModel.isWarningDismissed() && mail.authStatus === MailAuthenticationStatus.HARD_FAIL) {
			return m(InfoBanner, {
				message: "mailAuthFailed_msg",
				icon: Icons.Warning,
				helpLink: InfoLink.MailAuth,
				type: BannerType.Warning,
				buttons: [
					{
						label: "close_alt",
						click: () => (this.viewModel.setWarningDismissed(true)),
					},
				],
			})
		}
	}

	private renderSoftAuthenticationFailWarning(mail: Mail): Children | null {
		if (!this.viewModel.isWarningDismissed() && mail.authStatus === MailAuthenticationStatus.SOFT_FAIL) {
			return m(InfoBanner, {
				message: () =>
					mail.differentEnvelopeSender
						? lang.get("mailAuthMissingWithTechnicalSender_msg", {
							"{sender}": mail.differentEnvelopeSender,
						})
						: lang.get("mailAuthMissing_label"),
				icon: Icons.Warning,
				helpLink: InfoLink.MailAuth,
				buttons: [
					{
						label: "close_alt",
						click: () => (this.viewModel.setWarningDismissed(true)),
					},
				],
			})
		} else {
			return null
		}
	}

	private async setContentBlockingStatus(status: ContentBlockingStatus) {
		await this.viewModel.setContentBlockingStatus(status)
		// Wait for new mail body to be rendered before replacing images
		m.redraw.sync()
		await this.replaceInlineImages()
	}

	private renderExternalContentBanner(): Children | null {
		// only show banner when there are blocked images and the user hasn't made a decision about how to handle them
		if (this.viewModel.getContentBlockingStatus() !== ContentBlockingStatus.Block) {
			return null
		}

		const showButton: ButtonAttrs = {
			label: "showBlockedContent_action",
			click: () => this.setContentBlockingStatus(ContentBlockingStatus.Show),
		}
		const alwaysOrNeverAllowButtons: ReadonlyArray<ButtonAttrs> = locator.search.indexingSupported
			? [
				this.viewModel.isMailAuthenticated()
					? {
						label: "allowExternalContentSender_action" as const,
						click: () => this.setContentBlockingStatus(ContentBlockingStatus.AlwaysShow),
					}
					: null,
				{
					label: "blockExternalContentSender_action" as const,
					click: () => this.setContentBlockingStatus(ContentBlockingStatus.AlwaysBlock),
				},
			].filter(isNotNull)
			: []
		// on narrow screens the buttons will end up on 2 lines if there are too many, this looks bad.
		const maybeDropdownButtons =
			styles.isSingleColumnLayout() && alwaysOrNeverAllowButtons.length > 1
				? [createMoreSecondaryButtonAttrs(alwaysOrNeverAllowButtons, 216)]
				: alwaysOrNeverAllowButtons
		return m(InfoBanner, {
			message: "contentBlocked_msg",
			icon: Icons.Picture,
			helpLink: InfoLink.LoadImages,
			buttons: [showButton, ...maybeDropdownButtons],
		})
	}

	private addSpamRule(defaultInboxRuleField: InboxRuleType | null, address: string) {
		const folder = this.viewModel.mailModel.getMailFolder(getListId(this.viewModel.mail))

		const spamRuleType = folder && folder.folderType === MailFolderType.SPAM ? SpamRuleType.WHITELIST : SpamRuleType.BLACKLIST

		let spamRuleField: SpamRuleFieldType
		switch (defaultInboxRuleField) {
			case InboxRuleType.RECIPIENT_TO_EQUALS:
				spamRuleField = SpamRuleFieldType.TO
				break

			case InboxRuleType.RECIPIENT_CC_EQUALS:
				spamRuleField = SpamRuleFieldType.CC
				break

			case InboxRuleType.RECIPIENT_BCC_EQUALS:
				spamRuleField = SpamRuleFieldType.BCC
				break

			default:
				spamRuleField = SpamRuleFieldType.FROM
				break
		}

		import("../../settings/AddSpamRuleDialog").then(({showAddSpamRuleDialog}) => {
			showAddSpamRuleDialog(
				createEmailSenderListElement({
					value: address.trim().toLowerCase(),
					type: spamRuleType,
					field: spamRuleField,
				}),
			)
		})
	}

	private editDraft(): Promise<void> {
		return checkApprovalStatus(logins, false).then(sendAllowed => {
			if (sendAllowed) {
				// check if to be opened draft has already been minimized, iff that is the case, re-open it
				const minimizedEditor = locator.minimizedMailModel.getEditorForDraft(this.viewModel.mail)

				if (minimizedEditor) {
					locator.minimizedMailModel.reopenMinimizedEditor(minimizedEditor)
				} else {
					return Promise.all([this.viewModel.mailModel.getMailboxDetailsForMail(this.viewModel.mail), import("../editor/MailEditor")])
								  .then(([mailboxDetails, {newMailEditorFromDraft}]) => {
									  return newMailEditorFromDraft(
										  this.viewModel.mail,
										  this.viewModel.getAttachments(),
										  this.viewModel.getMailBody(),
										  this.viewModel.isBlockingExternalImages(),
										  this.viewModel.getLoadedInlineImages(),
										  mailboxDetails,
									  )
								  })
								  .then(editorDialog => {
									  editorDialog.show()
								  })
								  .catch(ofClass(UserError, showUserError))
				}
			}
		})
	}

	private scrollUp(): void {
		this.scrollIfDomBody(dom => {
			const current = dom.scrollTop
			const toScroll = dom.clientHeight * SCROLL_FACTOR
			return scroll(current, Math.max(0, current - toScroll))
		})
	}

	private scrollDown(): void {
		this.scrollIfDomBody(dom => {
			const current = dom.scrollTop
			const toScroll = dom.clientHeight * SCROLL_FACTOR
			return scroll(current, Math.min(dom.scrollHeight - dom.offsetHeight, dom.scrollTop + toScroll))
		})
	}

	private scrollToTop(): void {
		this.scrollIfDomBody(dom => {
			return scroll(dom.scrollTop, 0)
		})
	}

	private scrollToBottom(): void {
		this.scrollIfDomBody(dom => {
			const end = dom.scrollHeight - dom.offsetHeight
			return scroll(dom.scrollTop, end)
		})
	}

	private scrollIfDomBody(cb: (dom: HTMLElement) => DomMutation) {
		if (this.scrollDom) {
			const dom = this.scrollDom

			if (!this.scrollAnimation) {
				this.scrollAnimation = animations
					.add(dom, cb(dom), {
						easing: ease.inOut,
					})
					.then(() => {
						this.scrollAnimation = null
					})
			}
		}
	}

	private handleAnchorClick(event: Event, href: string | null, shouldDispatchSyntheticClick: boolean): void {
		if (href) {
			if (href.startsWith("mailto:")) {
				event.preventDefault()

				if (isNewMailActionAvailable()) {
					// disable new mails for external users.
					import("../editor/MailEditor").then(({newMailtoUrlMailEditor}) => {
						newMailtoUrlMailEditor(href, !logins.getUserController().props.defaultUnconfidential)
							.then(editor => editor.show())
							.catch(ofClass(CancelledError, noOp))
					})
				}
			} else if (isSettingsLink(href, this.viewModel.mail)) {
				// Navigate to the settings menu if they are linked within an email.
				const newRoute = href.substring(href.indexOf("/settings/"))
				m.route.set(newRoute)
				event.preventDefault()
			} else if (shouldDispatchSyntheticClick) {
				const syntheticTag = document.createElement("a")
				syntheticTag.setAttribute("href", href)
				syntheticTag.setAttribute("target", "_blank")
				syntheticTag.setAttribute("rel", "noopener noreferrer")
				const newClickEvent = new MouseEvent("click")
				syntheticTag.dispatchEvent(newClickEvent)
			}
		}
	}
}

type CreateMailViewerOptions = {
	mail: Mail
	showFolder: boolean
	delayBodyRenderingUntil?: Promise<void>
}

export function createMailViewerViewModel({mail, showFolder, delayBodyRenderingUntil}: CreateMailViewerOptions): MailViewerViewModel {
	return new MailViewerViewModel(
		mail,
		showFolder,
		delayBodyRenderingUntil ?? Promise.resolve(),
		locator.entityClient,
		locator.mailModel,
		locator.contactModel,
		locator.configFacade,
		isDesktop() ? locator.desktopSystemFacade : null,
		locator.fileFacade,
		locator.fileController,
		logins,
		locator.serviceExecutor
	)
}

/**
 * support and invoice mails can contain links to the settings page.
 * we don't want normal mails to be able to link places in the app, though.
 * */
function isSettingsLink(href: string, mail: Mail): boolean {
	return (href.startsWith("/settings/") ?? false) && isTutanotaTeamMail(mail)
}

function assertNonNull<T extends {}>(value: T | null | undefined): asserts value is T {
	if (value == null) {
		throw new ProgrammingError("it is null")
	}
}