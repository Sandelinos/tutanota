import m, {Children} from "mithril"
import {assertNotNull, DAY_IN_MILLIS, LazyLoaded, neverNull, noOp, ofClass, promiseMap} from "@tutao/tutanota-utils"
import {InfoLink, lang} from "../misc/LanguageViewModel"
import {getSpamRuleFieldToName, getSpamRuleTypeNameMapping, showAddSpamRuleDialog} from "./AddSpamRuleDialog"
import {getSpamRuleField, GroupType, OperationType, SpamRuleFieldType, SpamRuleType} from "../api/common/TutanotaConstants"
import {getCustomMailDomains} from "../api/common/utils/Utils"
import type {AuditLogEntry, Customer, CustomerInfo, CustomerServerProperties, DomainInfo, GroupInfo} from "../api/entities/sys/TypeRefs.js"
import {
	AuditLogEntryTypeRef,
	createEmailSenderListElement,
	CustomerInfoTypeRef,
	CustomerServerPropertiesTypeRef,
	CustomerTypeRef,
	GroupInfoTypeRef,
	GroupTypeRef,
	RejectedSenderTypeRef,
	UserTypeRef
} from "../api/entities/sys/TypeRefs.js"
import stream from "mithril/stream"
import Stream from "mithril/stream"
import {logins} from "../api/main/LoginController"
import {formatDateTime, formatDateTimeFromYesterdayOn} from "../misc/Formatter"
import {Dialog} from "../gui/base/Dialog"
import {LockedError, NotAuthorizedError, PreconditionFailedError} from "../api/common/error/RestError"
import {GroupData, loadEnabledTeamMailGroups, loadEnabledUserMailGroups, loadGroupDisplayName} from "./LoadingUtils"
import {Icons} from "../gui/base/icons/Icons"
import {showProgressDialog} from "../gui/dialogs/ProgressDialog"
import type {EntityUpdateData} from "../api/main/EventController"
import {isUpdateForTypeRef} from "../api/main/EventController"
import type {TableAttrs, TableLineAttrs} from "../gui/base/Table.js"
import {ColumnWidth, createRowActions} from "../gui/base/Table.js"
import {attachDropdown, createDropdown, DropdownChildAttrs} from "../gui/base/Dropdown.js"
import {ButtonType} from "../gui/base/Button.js"
import {DomainDnsStatus} from "./DomainDnsStatus"
import {showDnsCheckDialog} from "./CheckDomainDnsStatusDialog"
import {BootIcons} from "../gui/base/icons/BootIcons"
import {GENERATED_MAX_ID, generatedIdToTimestamp, getElementId, sortCompareByReverseId, timestampToGeneratedId} from "../api/common/utils/EntityUtils"
import {ExpandableTable} from "./ExpandableTable"
import {showRejectedSendersInfoDialog} from "./RejectedSendersInfoDialog"
import {showAddDomainWizard} from "./emaildomain/AddDomainWizard"
import {getUserGroupMemberships} from "../api/common/utils/GroupUtils"
import {showNotAvailableForFreeDialog} from "../misc/SubscriptionDialogs"
import {getDomainPart} from "../misc/parsing/MailAddressParser"
import type {UpdatableSettingsViewer} from "./SettingsView"
import {locator} from "../api/main/MainLocator"
import {assertMainOrNode} from "../api/common/Env"
import {DropDownSelector} from "../gui/base/DropDownSelector.js"

assertMainOrNode()
// Number of days for that we load rejected senders
const REJECTED_SENDERS_TO_LOAD_MS = 5 * DAY_IN_MILLIS
// Max number of rejected sender entries that we display in the ui
const REJECTED_SENDERS_MAX_NUMBER = 100

export class GlobalSettingsViewer implements UpdatableSettingsViewer {
	private readonly props = stream<Readonly<CustomerServerProperties>>()
	private customer: Customer | null = null
	private readonly customerInfo = new LazyLoaded<CustomerInfo>(() => this.loadCustomerInfo())

	private spamRuleLines: ReadonlyArray<TableLineAttrs> = []
	private rejectedSenderLines: ReadonlyArray<TableLineAttrs> = []
	private customDomainLines: ReadonlyArray<TableLineAttrs> = []
	private auditLogLines: ReadonlyArray<TableLineAttrs> = []
	private auditLogLoaded = false

	/**
	 * caches the current status for the custom email domains
	 * map from domain name to status
	 */
	private readonly domainDnsStatus: Record<string, DomainDnsStatus> = {}

	private requirePasswordUpdateAfterReset = false
	private saveIpAddress = false

	constructor() {
		this.props.map(props => {
			this.requirePasswordUpdateAfterReset = props.requirePasswordUpdateAfterReset
			this.saveIpAddress = props.saveEncryptedIpAddressInSession
		})

		this.view = this.view.bind(this)

		this.updateDomains()
		this.updateCustomerServerProperties()
		this.updateAuditLog()
	}

	view(): Children {
		const spamRuleTableAttrs: TableAttrs = {
			columnHeading: ["emailSender_label", "emailSenderRule_label"],
			columnWidths: [ColumnWidth.Largest, ColumnWidth.Small],
			showActionButtonColumn: true,
			addButtonAttrs: {
				label: "addSpamRule_action",
				click: () => showAddSpamRuleDialog(null),
				icon: () => Icons.Add,
			},
			lines: this.spamRuleLines,
		}
		const rejectedSenderTableAttrs: TableAttrs = {
			columnHeading: ["emailSender_label"],
			columnWidths: [ColumnWidth.Largest],
			showActionButtonColumn: true,
			addButtonAttrs: {
				label: "refresh_action",
				click: () => {
					this.updateRejectedSenderTable()
				},
				icon: () => BootIcons.Progress,
			},
			lines: this.rejectedSenderLines,
		}
		const customDomainTableAttrs: TableAttrs = {
			columnHeading: ["adminCustomDomain_label", "catchAllMailbox_label"],
			columnWidths: [ColumnWidth.Largest, ColumnWidth.Small],
			showActionButtonColumn: true,
			addButtonAttrs: {
				label: "addCustomDomain_action",
				click: () => {
					this.customerInfo.getAsync().then(customerInfo => {
						if (logins.getUserController().isFreeAccount()) {
							showNotAvailableForFreeDialog(getCustomMailDomains(customerInfo).length === 0)
						} else {
							showAddDomainWizard("", customerInfo).then(() => {
								this.updateDomains()
							})
						}
					})
				},
				icon: () => Icons.Add,
			},
			lines: this.customDomainLines,
		}
		const auditLogTableAttrs: TableAttrs = {
			columnHeading: ["action_label", "modified_label", "time_label"],
			columnWidths: [ColumnWidth.Largest, ColumnWidth.Largest, ColumnWidth.Small],
			showActionButtonColumn: true,
			lines: this.auditLogLines,
			addButtonAttrs: {
				label: "refresh_action",
				click: () => showProgressDialog("loading_msg", this.updateAuditLog()).then(() => m.redraw()),
				icon: () => BootIcons.Progress,
			},
		}
		return [
			m("#global-settings.fill-absolute.scroll.plr-l", [
				m(ExpandableTable, {
					title: "adminSpam_action",
					table: spamRuleTableAttrs,
					infoMsg: "adminSpamRuleInfo_msg",
					infoLinkId: InfoLink.SpamRules,
				}),
				m(ExpandableTable, {
					title: "rejectedEmails_label",
					table: rejectedSenderTableAttrs,
					infoMsg: "rejectedSenderListInfo_msg",
					onExpand: () => this.updateRejectedSenderTable(),
				}),
				m(ExpandableTable, {
					title: "customEmailDomains_label",
					table: customDomainTableAttrs,
					infoMsg: "moreInfo_msg",
					infoLinkId: InfoLink.DomainInfo,
				}),
				m(".mt-l", [
					m(".h4", lang.get("security_title")),
					m(DropDownSelector, {
						label: "saveEncryptedIpAddress_label",
						selectedValue: this.saveIpAddress,
						selectionChangedHandler: value => {
							const newProps = Object.assign(
								{},
								this.props(),
								{
									saveEncryptedIpAddressInSession: value,
								}
							)
							locator.entityClient.update(newProps)
						},
						items: [
							{
								name: lang.get("yes_label"),
								value: true,
							},
							{
								name: lang.get("no_label"),
								value: false,
							},
						],
						dropdownWidth: 250
					}),
					logins.getUserController().isGlobalAdmin() && logins.getUserController().isPremiumAccount()
						? m("", [
							m(DropDownSelector, {
								label: "enforcePasswordUpdate_title",
								helpLabel: () => lang.get("enforcePasswordUpdate_msg"),
								selectedValue: this.requirePasswordUpdateAfterReset,
								selectionChangedHandler: value => {
									const newProps: CustomerServerProperties = Object.assign(
										{},
										this.props(),
										{
											requirePasswordUpdateAfterReset: value,
										}
									)
									locator.entityClient.update(newProps)
								},
								items: [
									{
										name: lang.get("yes_label"),
										value: true,
									},
									{
										name: lang.get("no_label"),
										value: false,
									},
								],
								dropdownWidth: 250
							}),
							this.customer
								? m(
									".mt-l",
									m(ExpandableTable, {
										title: "auditLog_title",
										table: auditLogTableAttrs,
										infoMsg: "auditLogInfo_msg",
										onExpand: () => {
											// if the user did not load this when the view was created (i.e. due to a lost connection), attempt to reload it
											if (!this.auditLogLoaded) {
												showProgressDialog("loading_msg", this.updateAuditLog()).then(() => m.redraw())
											}
										},
									}),
								)
								: null,
						])
						: null,
				]),
			]),
		]
	}


	private updateCustomerServerProperties(): Promise<void> {
		return locator.customerFacade.loadCustomerServerProperties().then(props => {
			this.props(props)

			const fieldToName = getSpamRuleFieldToName()

			this.spamRuleLines = props.emailSenderList.map((rule, index) => {
				return {
					cells: () => [
						{
							main: fieldToName[getSpamRuleField(rule)],
							info: [rule.value],
						},
						{
							main: neverNull(getSpamRuleTypeNameMapping().find(t => t.value === rule.type)).name,
						},
					],
					actionButtonAttrs: createRowActions(
						{
							getArray: () => props.emailSenderList,
							updateInstance: () => locator.entityClient.update(props).catch(ofClass(LockedError, noOp)),
						},
						rule,
						index,
						[
							{
								label: "edit_action",
								click: () => showAddSpamRuleDialog(rule),
								type: ButtonType.Dropdown,
							},
						],
					),
				}
			})

			m.redraw()
		})
	}

	private updateRejectedSenderTable(): void {
		const customer = this.customer

		if (customer && customer.rejectedSenders) {
			// Rejected senders are written with TTL for seven days.
			// We have to avoid that we load too many (already deleted) rejected senders form the past.
			// First we load REJECTED_SENDERS_MAX_NUMBER items starting from the past timestamp into the future. If there are
			// more entries available we can safely load REJECTED_SENDERS_MAX_NUMBER from GENERATED_MAX_ID in reverse order.
			// Otherwise we will just use what has been returned in the first request.
			const senderListId = customer.rejectedSenders.items
			const startId = timestampToGeneratedId(Date.now() - REJECTED_SENDERS_TO_LOAD_MS)
			const loadingPromise = locator.entityClient
										  .loadRange(RejectedSenderTypeRef, senderListId, startId, REJECTED_SENDERS_MAX_NUMBER, false)
										  .then(rejectedSenders => {
											  if (REJECTED_SENDERS_MAX_NUMBER === rejectedSenders.length) {
												  // There are more entries available, we need to load from GENERATED_MAX_ID.
												  // we don't need to sort here because we load in reverse direction
												  return locator.entityClient.loadRange(RejectedSenderTypeRef, senderListId, GENERATED_MAX_ID, REJECTED_SENDERS_MAX_NUMBER, true)
											  } else {
												  // ensure that rejected senders are sorted in descending order
												  return rejectedSenders.sort(sortCompareByReverseId)
											  }
										  })
										  .then(rejectedSenders => {
											  this.rejectedSenderLines = rejectedSenders.map(rejectedSender => {
												  const rejectDate = formatDateTime(new Date(generatedIdToTimestamp(getElementId(rejectedSender))))
												  return {
													  cells: () => {
														  return [
															  {
																  main: rejectedSender.senderMailAddress,
																  info: [`${rejectDate}, ${rejectedSender.senderHostname} (${rejectedSender.senderIp})`],
																  click: () => showRejectedSendersInfoDialog(rejectedSender),
															  },
														  ]
													  },
													  actionButtonAttrs: attachDropdown(
														  {
															  mainButtonAttrs: {
																  label: "showMore_action",
																  icon: () => Icons.More,
															  }, childAttrs: () => [
																  {
																	  label: "showRejectReason_action",
																	  type: ButtonType.Dropdown,
																	  click: () => showRejectedSendersInfoDialog(rejectedSender),
																  },
																  {
																	  label: "addSpamRule_action",
																	  type: ButtonType.Dropdown,
																	  click: () => {
																		  const domainPart = getDomainPart(rejectedSender.senderMailAddress)
																		  showAddSpamRuleDialog(
																			  createEmailSenderListElement({
																				  value: domainPart ? domainPart : "",
																				  type: SpamRuleType.WHITELIST,
																				  field: SpamRuleFieldType.FROM,
																			  }),
																		  )
																	  },
																  },
															  ]
														  },
													  ),
												  }
											  })
										  })
			showProgressDialog("loading_msg", loadingPromise).then(() => m.redraw())
		}
	}

	private updateAuditLog(): Promise<void> {
		return locator.entityClient.load(CustomerTypeRef, neverNull(logins.getUserController().user.customer)).then(customer => {
			this.customer = customer

			return locator.entityClient.loadRange(AuditLogEntryTypeRef, neverNull(customer.auditLog).items, GENERATED_MAX_ID, 200, true).then(auditLog => {
				this.auditLogLoaded = true // indicate that we do not need to reload the list again when we expand
				this.auditLogLines = auditLog.map(auditLogEntry => {
					return {
						cells: [auditLogEntry.action, auditLogEntry.modifiedEntity, formatDateTimeFromYesterdayOn(auditLogEntry.date)],
						actionButtonAttrs: {
							label: "showMore_action",
							icon: () => Icons.More,
							click: () => this.showAuditLogDetails(auditLogEntry, customer),
						},
					}
				})
			})
		})
	}

	private showAuditLogDetails(entry: AuditLogEntry, customer: Customer) {
		let modifiedGroupInfo: Stream<GroupInfo> = stream()
		let groupInfo = stream<GroupInfo>()
		let groupInfoLoadingPromises: Promise<unknown>[] = []

		if (entry.modifiedGroupInfo) {
			groupInfoLoadingPromises.push(
				locator.entityClient
					   .load(GroupInfoTypeRef, entry.modifiedGroupInfo)
					   .then(gi => {
						   modifiedGroupInfo(gi)
					   })
					   .catch(
						   ofClass(NotAuthorizedError, () => {
							   // If the admin is removed from the free group, he does not have the permission to access the groupinfo of that group anymore
						   }),
					   ),
			)
		}

		if (entry.groupInfo) {
			groupInfoLoadingPromises.push(
				locator.entityClient
					   .load(GroupInfoTypeRef, entry.groupInfo)
					   .then(gi => {
						   groupInfo(gi)
					   })
					   .catch(
						   ofClass(NotAuthorizedError, () => {
							   // If the admin is removed from the free group, he does not have the permission to access the groupinfo of that group anymore
						   }),
					   ),
			)
		}

		Promise.all(groupInfoLoadingPromises).then(() => {
			const groupInfoValue = groupInfo();
			let dialog = Dialog.showActionDialog({
				title: lang.get("auditLog_title"),
				child: {
					view: () =>
						m("table.pt", [
							m("tr", [m("td", lang.get("action_label")), m("td.pl", entry.action)]),
							m("tr", [m("td", lang.get("actor_label")), m("td.pl", entry.actorMailAddress)]),
							m("tr", [m("td", lang.get("IpAddress_label")), m("td.pl", entry.actorIpAddress ? entry.actorIpAddress : "")]),
							m("tr", [
								m("td", lang.get("modified_label")),
								m(
									"td.pl",
									modifiedGroupInfo() && this.getGroupInfoDisplayText(modifiedGroupInfo())
										? this.getGroupInfoDisplayText(modifiedGroupInfo())
										: entry.modifiedEntity,
								),
							]),
							groupInfoValue
								? m("tr", [
									m("td", lang.get("group_label")),
									m(
										"td.pl",
										customer.adminGroup === groupInfoValue.group
											? lang.get("globalAdmin_label")
											: this.getGroupInfoDisplayText(groupInfoValue),
									),
								])
								: null,
							m("tr", [m("td", lang.get("time_label")), m("td.pl", formatDateTime(entry.date))]),
						]),
				},
				allowOkWithReturn: true,
				okAction: () => dialog.close(),
				allowCancel: false,
			})
		})
	}

	private getGroupInfoDisplayText(groupInfo: GroupInfo): string {
		if (groupInfo.name && groupInfo.mailAddress) {
			return groupInfo.name + " <" + groupInfo.mailAddress + ">"
		} else if (groupInfo.mailAddress) {
			return groupInfo.mailAddress
		} else {
			return groupInfo.name
		}
	}

	private async updateDomains(): Promise<void> {
		return this.customerInfo.getAsync().then(customerInfo => {
			let customDomainInfos = getCustomMailDomains(customerInfo)
			// remove dns status instances for all removed domains
			Object.keys(this.domainDnsStatus).forEach(domain => {
				if (!customDomainInfos.find(di => di.domain === domain)) {
					delete this.domainDnsStatus[domain]
				}
			})
			return promiseMap(customDomainInfos, domainInfo => {
				// create dns status instances for all new domains
				if (!this.domainDnsStatus[domainInfo.domain]) {
					this.domainDnsStatus[domainInfo.domain] = new DomainDnsStatus(domainInfo.domain)

					this.domainDnsStatus[domainInfo.domain].loadCurrentStatus().then(() => {
						m.redraw()
					})
				}

				let domainDnsStatus = this.domainDnsStatus[domainInfo.domain]
				let p = Promise.resolve(lang.get("comboBoxSelectionNone_msg"))

				if (domainInfo.catchAllMailGroup) {
					p = loadGroupDisplayName(domainInfo.catchAllMailGroup)
				}

				return p.then(catchAllGroupName => {
					return {
						cells: () => [
							{
								main: domainInfo.domain,
								info: [domainDnsStatus.getDnsStatusInfo()],
								click:
									domainDnsStatus.status.isLoaded() && !domainDnsStatus.areAllRecordsFine()
										? () => {
											showDnsCheckDialog(domainDnsStatus)
										}
										: noOp,
							},
							{
								main: catchAllGroupName,
							},
						],
						actionButtonAttrs: {
							label: "action_label" as const,
							icon: () => Icons.More,
							click: createDropdown(
								{
									lazyButtons: () => {

										const buttons: DropdownChildAttrs[] = [
											{
												type: ButtonType.Dropdown,
												label: "setCatchAllMailbox_action",
												click: () => this.editCatchAllMailbox(domainInfo),
											},
											{
												type: ButtonType.Dropdown,
												label: "delete_action",
												click: () => this.deleteCustomDomain(domainInfo),
											}
										]

										if (domainDnsStatus.status.isLoaded() && !domainDnsStatus.areAllRecordsFine()) {
											buttons.unshift({
												type: ButtonType.Dropdown,
												label: "resumeSetup_label",
												click: () => {
													showAddDomainWizard(domainDnsStatus.domain, customerInfo).then(() => {
														domainDnsStatus.loadCurrentStatus().then(() => m.redraw())
													})
												},
											})
										}
										return buttons
									}, width: 260
								},
							),
						},
					}
				})
			}).then(tableLines => {
				this.customDomainLines = tableLines

				m.redraw()
			})
		})
	}

	private async editCatchAllMailbox(domainInfo: DomainInfo) {
		const groupDatas = await showProgressDialog("pleaseWait_msg", this.loadMailboxGroupDataAndCatchAllId(domainInfo))
		const initialValue = groupDatas.selected?.groupId ?? null
		const selectedMailGroupId = await Dialog.showDropDownSelectionDialog(
			"setCatchAllMailbox_action",
			"catchAllMailbox_label",
			null,
			[
				{
					name: lang.get("comboBoxSelectionNone_msg"),
					value: null,
				},
				...groupDatas.available.map(groupData => {
					return {
						name: groupData.displayName,
						value: groupData.groupId,
					}
				})
			],
			initialValue,
			250,
		)
		return locator.customerFacade.setCatchAllGroup(domainInfo.domain, selectedMailGroupId)
	}

	private async loadMailboxGroupDataAndCatchAllId(domainInfo: DomainInfo): Promise<{available: Array<GroupData>, selected: GroupData | null}> {
		const customer = await locator.entityClient.load(CustomerTypeRef, neverNull(logins.getUserController().user.customer))
		const teamMailGroups = await loadEnabledTeamMailGroups(customer)
		const userMailGroups = await loadEnabledUserMailGroups(customer)
		const allMailGroups = teamMailGroups.concat(userMailGroups)
		let catchAllMailGroupId: Id | null = null
		if (domainInfo.catchAllMailGroup) {

			const catchAllGroup = await locator.entityClient.load(GroupTypeRef, domainInfo.catchAllMailGroup)
			if (catchAllGroup.type === GroupType.User) {
				// the catch all group may be a user group, so load the mail group in that case
				const user = await locator.entityClient.load(UserTypeRef, neverNull(catchAllGroup.user))
				catchAllMailGroupId = getUserGroupMemberships(user, GroupType.Mail)[0].group // the first is the users personal mail group
			} else {
				catchAllMailGroupId = domainInfo.catchAllMailGroup
			}
		}

		return {
			available: allMailGroups,
			selected: allMailGroups.find(g => g.groupId === catchAllMailGroupId) ?? null,
		}
	}


	private deleteCustomDomain(domainInfo: DomainInfo) {
		Dialog.confirm(() =>
			lang.get("confirmCustomDomainDeletion_msg", {
				"{domain}": domainInfo.domain,
			}),
		).then(confirmed => {
			if (confirmed) {
				locator.customerFacade
					   .removeDomain(domainInfo.domain)
					   .catch(
						   ofClass(PreconditionFailedError, () => {
							   let registrationDomains =
								   this.props() != null ? this.props().whitelabelRegistrationDomains.map(domainWrapper => domainWrapper.value) : []

							   if (registrationDomains.indexOf(domainInfo.domain) !== -1) {
								   Dialog.message(() =>
									   lang.get("customDomainDeletePreconditionWhitelabelFailed_msg", {
										   "{domainName}": domainInfo.domain,
									   }),
								   )
							   } else {
								   Dialog.message(() =>
									   lang.get("customDomainDeletePreconditionFailed_msg", {
										   "{domainName}": domainInfo.domain,
									   }),
								   )
							   }
						   }),
					   )
					   .catch(ofClass(LockedError, () => Dialog.message("operationStillActive_msg")))
			}
		})
	}

	private loadCustomerInfo(): Promise<CustomerInfo> {
		return locator.entityClient
					  .load(CustomerTypeRef, assertNotNull(logins.getUserController().user.customer))
					  .then(customer => locator.entityClient.load(CustomerInfoTypeRef, customer.customerInfo))
	}

	entityEventsReceived(updates: ReadonlyArray<EntityUpdateData>): Promise<void> {
		return promiseMap(updates, update => {
			if (isUpdateForTypeRef(CustomerServerPropertiesTypeRef, update) && update.operation === OperationType.UPDATE) {
				return this.updateCustomerServerProperties()
			} else if (isUpdateForTypeRef(AuditLogEntryTypeRef, update)) {
				return this.updateAuditLog()
			} else if (isUpdateForTypeRef(CustomerInfoTypeRef, update) && update.operation === OperationType.UPDATE) {
				this.customerInfo.reset()

				return this.updateDomains()
			}
		}).then(noOp)
	}
}