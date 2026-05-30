import{v as e,i as t,n as s,r as i,e as o,a,b as n,x as r,w as d}from"../../chunks/third-party.js";import{E as c}from"../../chunks/harmony-types.js";import{u as l}from"../../chunks/utils.js";import"../../chunks/shoelace.js";import{i as h}from"../../chunks/icon-cross.js";import{i as p}from"../../chunks/icon-play.js";import{c as g}from"../../chunks/css/preference-window.js";var u=Object.defineProperty,m=Object.getOwnPropertyDescriptor,v=(e,t,s,i)=>{for(var o,a=i>1?void 0:i?m(t,s):t,n=e.length-1;n>=0;n--)(o=e[n])&&(a=(i?o(t,s,a):o(a))||a);return i&&a&&u(t,s,a),a};const f=3e3,b=300,M=200,C=800,w=300,k={absoluteTimestamp:!1},x={renderHTMLBlock:!1},$={author:[],recipient:[],contentType:[]},y=["user","assistant","system","developer","tool"].toSorted(),S=["all"].toSorted(),T=[...c].sort();let H=class extends a{constructor(){super(),this.enabledOptions={maxMessageHeight:!0,gridView:!1,expandAndCollapseAll:!0,advanced:!0,messageLabel:!0,focusMode:!0,comparisonWidth:!1},this.defaultOptions={gridView:!1,gridViewColumnWidth:b,comparisonWidth:w},this.isDarkTheme=!1,this.useCustomMessageHeight=!1,this.preferenceMaxMessageHeightMode="automatic",this.preferenceCustomMaxMessageHeight=300,this.preferenceCustomGridViewColumnWidth=b,this.preferenceCustomComparisonWidth=w,this.isAdvancedSectionCollapsed=!0,this.isFocusModeSectionCollapsed=!0,this.messageLabelSettings={...k},this.advancedSettings={...x},this.focusModeSettings={...$},this.isGridView=!1,this.tooltipDebouncer=null}loadPreferencesFromStorage(){const e=window.localStorage.getItem("preference-max-message-height-mode");e&&(this.preferenceMaxMessageHeightMode=e,this.useCustomMessageHeight="custom"===this.preferenceMaxMessageHeightMode);const t=window.localStorage.getItem("preference-max-message-height");t&&(this.preferenceCustomMaxMessageHeight=Math.max(0,Math.min(f,parseInt(t)))),"automatic"!==this.preferenceMaxMessageHeightMode&&this.notifyParentMaxMessageHeight();const s=window.localStorage.getItem("preference-comparison-width");if(s){const e=parseInt(s);this.preferenceCustomComparisonWidth=Math.max(M,Math.min(C,e)),this.preferenceCustomComparisonWidth!==w&&this.notifyParentComparisonWidth()}const i=window.localStorage.getItem("preference-message-label-settings");i&&(this.messageLabelSettings=JSON.parse(i),this.messageLabelSettings.absoluteTimestamp!==k.absoluteTimestamp&&this.notifyParentMessageLabelSettings());const o=window.localStorage.getItem("preference-advanced-settings");if(o){const e=JSON.parse(o);this.advancedSettings={...x,...e}}const a=window.localStorage.getItem("preference-focus-mode-settings");a&&(this.focusModeSettings=JSON.parse(a),(this.focusModeSettings.author.length>0||this.focusModeSettings.recipient.length>0||this.focusModeSettings.contentType.length>0)&&this.notifyParentFocusModeSettings())}writePreferencesToStorage(){window.localStorage.setItem("preference-max-message-height-mode",this.preferenceMaxMessageHeightMode),window.localStorage.setItem("preference-max-message-height",this.preferenceCustomMaxMessageHeight.toString()),window.localStorage.setItem("preference-comparison-width",this.preferenceCustomComparisonWidth.toString()),window.localStorage.setItem("preference-message-label-settings",JSON.stringify(this.messageLabelSettings)),window.localStorage.setItem("preference-advanced-settings",JSON.stringify(this.advancedSettings)),window.localStorage.setItem("preference-focus-mode-settings",JSON.stringify(this.focusModeSettings))}firstUpdated(){this.loadPreferencesFromStorage()}willUpdate(e){e.has("defaultOptions")&&(this.isGridView=this.defaultOptions.gridView,this.preferenceCustomGridViewColumnWidth=this.defaultOptions.gridViewColumnWidth,this.preferenceCustomComparisonWidth=this.defaultOptions.comparisonWidth)}async initData(){}onDragStart(e){e.preventDefault();const t=e.clientX,s=e.clientY,i=this.offsetTop,o=this.offsetLeft,a=e=>{const a=e.clientX-t,n=e.clientY-s;this.style.top=`${i+n}px`,this.style.left=`${o+a}px`},n=()=>{window.removeEventListener("mousemove",a),window.removeEventListener("mouseup",n)};window.addEventListener("mousemove",a),window.addEventListener("mouseup",n)}maxMessageHeightRadioChanged(){if(!this.radioGroupMaxMessageHeight)throw Error("Radio group max message height not found");const e=this.radioGroupMaxMessageHeight.value;switch(e){case"automatic":this.preferenceMaxMessageHeightMode="automatic",this.useCustomMessageHeight=!1;break;case"no-limit":this.preferenceMaxMessageHeightMode="no-limit",this.useCustomMessageHeight=!1;break;case"custom":this.preferenceMaxMessageHeightMode="custom",this.useCustomMessageHeight=!0;break;default:throw Error(`Invalid value for max message height: ${e}`)}this.writePreferencesToStorage(),this.notifyParentMaxMessageHeight()}maxMessageHeightRangeInput(e){const t=e.target;this.preferenceCustomMaxMessageHeight=t.value,this.notifyParentMaxMessageHeight()}maxMessageHeightRangeChanged(e){const t=e.target;this.preferenceCustomMaxMessageHeight=t.value,this.writePreferencesToStorage(),this.notifyParentMaxMessageHeight()}layoutRadioChanged(){if(!this.radioGroupLayout)throw Error("Radio group layout not found");const e=this.radioGroupLayout.value;switch(e){case"list":this.isGridView=!1;break;case"grid":this.isGridView=!0;break;default:throw Error(`Invalid value for layout: ${e}`)}this.notifyParentLayoutChange(e),"grid"===e&&this.notifyParentGridViewColumnWidth()}gridViewColumnWidthRangeInput(e){const t=e.target;this.preferenceCustomGridViewColumnWidth=t.value,this.notifyParentGridViewColumnWidth()}gridViewColumnWidthRangeChanged(e){const t=e.target;this.preferenceCustomGridViewColumnWidth=t.value,this.writePreferencesToStorage(),this.notifyParentGridViewColumnWidth()}comparisonWidthRangeInput(e){const t=e.target;this.preferenceCustomComparisonWidth=t.value,this.notifyParentComparisonWidth()}comparisonWidthRangeChanged(e){const t=e.target;this.preferenceCustomComparisonWidth=t.value,this.writePreferencesToStorage(),this.notifyParentComparisonWidth()}expandAllButtonClicked(){this.dispatchEvent(new Event("expand-all-clicked",{bubbles:!0,composed:!0}))}collapseAllButtonClicked(){this.dispatchEvent(new Event("collapse-all-clicked",{bubbles:!0,composed:!0}))}translateAllButtonClicked(){this.dispatchEvent(new Event("translate-all-clicked",{bubbles:!0,composed:!0}))}messageLabelCheckBoxChanged(e,t){const s=e.target;this.messageLabelSettings[t]=s.checked,this.writePreferencesToStorage(),this.notifyParentMessageLabelSettings()}advancedCheckboxChanged(e,t){const s=e.target;this.advancedSettings[t]=s.checked,this.writePreferencesToStorage(),this.notifyParentAdvancedSettings()}focusModeCheckBoxChanged(e,t,s){e.target.checked?this.focusModeSettings[t].push(s):this.focusModeSettings[t]=this.focusModeSettings[t].filter(e=>e!==s),this.writePreferencesToStorage(),this.notifyParentFocusModeSettings()}tooltipTargetMouseEnter(e,t,s){if(e.stopPropagation(),e.preventDefault(),!this.popperTooltip)return void console.error("Popper tooltip not initialized.");const i=e.currentTarget;this.tooltipDebouncer&&clearTimeout(this.tooltipDebouncer),this.tooltipDebouncer=window.setTimeout(()=>{const e=this.popperTooltip.querySelector(".popper-label");let o="Button";switch(t){case"absoluteTimestamp":o="Always show the absolute timestamp of the message's create time instead of relative to the first message";break;case"renderHTMLBlock":o="Use a sandboxed iframe to render html code blocks in markdown. Refresh the page after changing this setting.";break;case"focusModeAuthor":o="Show messages with author "+(s?` ${s}`:"");break;case"focusModeRecipient":o="Show messages with recipient "+(s?` ${s}`:"");break;case"focusModeMessageContentType":o="Show messages with type "+(s?` ${s}`:"")}e.textContent=o,l(this.popperTooltip,i,"top",!0,7),this.popperTooltip.classList.remove("hidden")},500)}tooltipTargetMouseLeave(e=!0){this.popperTooltip?(this.tooltipDebouncer&&(clearTimeout(this.tooltipDebouncer),this.tooltipDebouncer=null),e?this.popperTooltip.classList.add("hidden"):(this.popperTooltip.classList.add("no-transition"),this.popperTooltip.classList.add("hidden"),setTimeout(()=>{this.popperTooltip.classList.remove("no-transition")},150))):console.error("popperTooltip are not initialized yet.")}notifyParentMaxMessageHeight(){let e="100vh";"no-limit"===this.preferenceMaxMessageHeightMode?e="none":"custom"===this.preferenceMaxMessageHeightMode&&(e=`${this.preferenceCustomMaxMessageHeight}px`);const t=new CustomEvent("max-message-height-changed",{bubbles:!0,composed:!0,detail:e});this.dispatchEvent(t)}notifyParentGridViewColumnWidth(){const e=new CustomEvent("grid-view-column-width-changed",{bubbles:!0,composed:!0,detail:`${this.preferenceCustomGridViewColumnWidth}px`});this.dispatchEvent(e)}notifyParentComparisonWidth(){const e=new CustomEvent("comparison-width-changed",{bubbles:!0,composed:!0,detail:`${this.preferenceCustomComparisonWidth}px`});this.dispatchEvent(e)}notifyParentLayoutChange(e){const t=new CustomEvent("layout-changed",{bubbles:!0,composed:!0,detail:e});this.dispatchEvent(t)}notifyParentMessageLabelSettings(){const e=new CustomEvent("message-label-changed",{bubbles:!0,composed:!0,detail:this.messageLabelSettings});this.dispatchEvent(e)}notifyParentAdvancedSettings(){const e=new CustomEvent("advanced-settings-changed",{bubbles:!0,composed:!0,detail:this.advancedSettings});this.dispatchEvent(e)}notifyParentFocusModeSettings(){const e=new CustomEvent("focus-mode-settings-changed",{bubbles:!0,composed:!0,detail:this.focusModeSettings});this.dispatchEvent(e)}render(){const e=n`
      <div
        id="popper-tooltip"
        class="popper-tooltip hidden"
        role="tooltip"
        @click=${e=>{e.stopPropagation()}}
      >
        <div class="popper-content">
          <span class="popper-label">Hello</span>
        </div>
        <div class="popper-arrow"></div>
      </div>
    `;let t=n``;for(const e of y)t=n`${t}
        <div
          class="checkbox-group"
          @mouseover=${t=>{this.tooltipTargetMouseEnter(t,"focusModeAuthor",e)}}
          @mouseleave=${()=>{this.tooltipTargetMouseLeave()}}
        >
          <input
            type="checkbox"
            id="checkbox-focus-mode-author-${e}"
            .checked=${this.focusModeSettings.author.includes(e)}
            @change=${t=>{this.focusModeCheckBoxChanged(t,"author",e)}}
          />
          <label for="checkbox-focus-mode-author-${e}">${e}</label>
        </div> `;let s=n``;for(const e of S)s=n`${s}
        <div
          class="checkbox-group"
          @mouseover=${t=>{this.tooltipTargetMouseEnter(t,"focusModeRecipient",e)}}
          @mouseleave=${()=>{this.tooltipTargetMouseLeave()}}
        >
          <input
            type="checkbox"
            id="checkbox-focus-mode-recipient-${e}"
            .checked=${this.focusModeSettings.recipient.includes(e)}
            @change=${t=>{this.focusModeCheckBoxChanged(t,"recipient",e)}}
          />
          <label for="checkbox-focus-mode-recipient-${e}"
            >${e}</label
          >
        </div> `;let i=n``;for(const e of T)i=n`${i}
        <div
          class="checkbox-group"
          @mouseover=${t=>{this.tooltipTargetMouseEnter(t,"focusModeMessageContentType",e)}}
          @mouseleave=${()=>{this.tooltipTargetMouseLeave()}}
        >
          <input
            type="checkbox"
            id="checkbox-focus-mode-content-type-${e}"
            .checked=${this.focusModeSettings.contentType.includes(e)}
            @change=${t=>{this.focusModeCheckBoxChanged(t,"contentType",e)}}
          />
          <label for="checkbox-focus-mode-content-type-${e}"
            >${e}</label
          >
        </div> `;return n`
      ${e}
      <div class="preference-window">
        <div
          class="header"
          @mousedown=${e=>{this.onDragStart(e)}}
        >
          <span class="title">Preferences</span>
          <button
            class="close-button svg-icon"
            @click=${()=>{const e=new CustomEvent("preference-window-close-clicked",{bubbles:!0,composed:!0});this.dispatchEvent(e)}}
          >
            ${r(h)}
          </button>
        </div>

        <div class="content">
          <div
            class="setting-block"
            ?is-hidden=${!this.enabledOptions.maxMessageHeight}
          >
            <div class="setting-block-header">Max Message Height</div>
            <div class="setting-block-content">
              <div class="form-row">
                <sl-radio-group
                  size="small"
                  name="max-message-height"
                  id="radio-group-max-message-height"
                  value=${this.preferenceMaxMessageHeightMode}
                  @sl-change=${()=>{this.maxMessageHeightRadioChanged()}}
                >
                  <sl-radio size="small" value="automatic">Automatic</sl-radio>
                  <sl-radio size="small" value="no-limit">No Limit</sl-radio>
                  <sl-radio size="small" value="custom"
                    >Custom Height
                    (${this.preferenceCustomMaxMessageHeight}px)</sl-radio
                  >
                </sl-radio-group>
              </div>

              <div class="form-row">
                <sl-range
                  @sl-input=${e=>{this.maxMessageHeightRangeInput(e)}}
                  @sl-change=${e=>{this.maxMessageHeightRangeChanged(e)}}
                  ?disabled=${!this.useCustomMessageHeight}
                  min="50"
                  max=${f}
                  value=${this.preferenceCustomMaxMessageHeight}
                ></sl-range>
              </div>
            </div>
          </div>

          <div
            class="divider"
            ?is-hidden=${!this.enabledOptions.maxMessageHeight}
          ></div>

          <div
            class="setting-block"
            ?is-hidden=${!this.enabledOptions.messageLabel}
          >
            <div class="setting-block-header">Message Labels</div>
            <div class="setting-block-content">
              <div class="form-block checkbox-block">
                <div
                  class="checkbox-group"
                  @mouseover=${e=>{this.tooltipTargetMouseEnter(e,"absoluteTimestamp")}}
                  @mouseleave=${()=>{this.tooltipTargetMouseLeave()}}
                >
                  <input
                    type="checkbox"
                    id="checkbox-absolute-timestamp"
                    .checked=${this.messageLabelSettings.absoluteTimestamp}
                    @change=${e=>{this.messageLabelCheckBoxChanged(e,"absoluteTimestamp")}}
                  />
                  <label for="checkbox-absolute-timestamp"
                    >absolute timestamp</label
                  >
                </div>
              </div>
            </div>
          </div>

          <div
            class="divider"
            ?is-hidden=${!this.enabledOptions.messageLabel}
          ></div>

          <div
            class="setting-block"
            ?is-hidden=${!this.enabledOptions.gridView}
          >
            <div class="setting-block-header">Layout</div>
            <div class="setting-block-content">
              <div class="form-row">
                <sl-radio-group
                  size="small"
                  name="layout"
                  id="radio-group-layout"
                  value=${this.isGridView?"grid":"list"}
                  @sl-change=${()=>{this.layoutRadioChanged()}}
                >
                  <sl-radio size="small" value="list">List View</sl-radio>
                  <sl-radio size="small" value="grid"
                    >Grid View (
                    ${this.preferenceCustomGridViewColumnWidth}px)</sl-radio
                  >
                </sl-radio-group>
              </div>

              <div class="form-row">
                  <sl-range
                    @sl-input=${e=>{this.gridViewColumnWidthRangeInput(e)}}
                  @sl-change=${e=>{this.gridViewColumnWidthRangeChanged(e)}}
                  min="200"
                  max="800"
                  ?disabled=${!this.isGridView}
                  value=${this.preferenceCustomGridViewColumnWidth}
                ></sl-range>
              </div>
            </div>
          </div>

          <div
            class="divider"
            ?is-hidden=${!this.enabledOptions.gridView}
          ></div>

          <div
            class="setting-block"
            ?is-hidden=${!this.enabledOptions.comparisonWidth}
          >
            <div class="setting-block-header">
              Comparison Width (${this.preferenceCustomComparisonWidth}px)
            </div>
            <div class="setting-block-content">
              <div class="form-row">
                <sl-range
                  @sl-input=${e=>{this.comparisonWidthRangeInput(e)}}
                  @sl-change=${e=>{this.comparisonWidthRangeChanged(e)}}
                  min=${M}
                  max=${C}
                  value=${this.preferenceCustomComparisonWidth}
                ></sl-range>
              </div>
            </div>
          </div>

          <div
            class="divider"
            ?is-hidden=${!this.enabledOptions.comparisonWidth}
          ></div>

          <div
            class="setting-block"
            ?is-hidden=${!this.enabledOptions.focusMode}
          >
            <div class="setting-block-header">
              <button
                class="svg-icon collapse-icon"
                ?is-collapsed=${this.isFocusModeSectionCollapsed}
                @click=${()=>{this.isFocusModeSectionCollapsed=!this.isFocusModeSectionCollapsed}}
              >
                ${r(p)}
              </button>
              <span>Focus Mode</span>
            </div>
            <div
              class="setting-block-content"
              ?is-hidden=${this.isFocusModeSectionCollapsed}
            >
              <div class="form-block checkbox-block">
                <div class="form-block-header">Focus by author</div>
                ${t}
                <div class="form-block-header">Focus by recipient</div>
                ${s}
                <div class="form-block-header">Focus by content type</div>
                ${i}
              </div>
            </div>
          </div>

          <div
            class="divider"
            ?is-hidden=${!this.enabledOptions.focusMode}
          ></div>

          <div
            class="setting-block"
            ?is-hidden=${!this.enabledOptions.advanced}
          >
            <div class="setting-block-header">
              <button
                class="svg-icon collapse-icon"
                ?is-collapsed=${this.isAdvancedSectionCollapsed}
                @click=${()=>{this.isAdvancedSectionCollapsed=!this.isAdvancedSectionCollapsed}}
              >
                ${r(p)}
              </button>
              <span>Advanced</span>
            </div>
            <div
              class="setting-block-content"
              ?is-hidden=${this.isAdvancedSectionCollapsed}
            >
              <div class="form-block checkbox-block">
                <div
                  class="checkbox-group"
                  @mouseover=${e=>{this.tooltipTargetMouseEnter(e,"renderHTMLBlock")}}
                  @mouseleave=${()=>{this.tooltipTargetMouseLeave()}}
                >
                  <input
                    type="checkbox"
                    id="checkbox-render-html-block"
                    .checked=${this.advancedSettings.renderHTMLBlock}
                    @change=${e=>{this.advancedCheckboxChanged(e,"renderHTMLBlock")}}
                  />
                  <label for="checkbox-render-html-block"
                    >render html code block</label
                  >
                </div>
              </div>
            </div>
          </div>

          <div
            class="divider"
            ?is-hidden=${!this.enabledOptions.advanced}
          ></div>

          <div
            class="setting-block"
            ?is-hidden=${!this.enabledOptions.expandAndCollapseAll}
          >
            <div class="setting-block-header">Quick Actions</div>
            <div class="setting-block-content">
              <div class="form-row form-row-quick-actions">
                <button
                  class="text-button"
                  @click=${()=>{this.expandAllButtonClicked()}}
                >
                  Expand All
                </button>
                <button
                  class="text-button"
                  @click=${()=>{this.collapseAllButtonClicked()}}
                >
                  Collapse All
                </button>
                <button
                  class="text-button"
                  @click=${()=>{this.translateAllButtonClicked()}}
                >
                  Translate All
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `}};H.styles=[t`
      ${e(g)}
    `],v([s({type:Object})],H.prototype,"enabledOptions",2),v([s({type:Object})],H.prototype,"defaultOptions",2),v([s({type:Boolean,attribute:"is-dark-theme",reflect:!0})],H.prototype,"isDarkTheme",2),v([i()],H.prototype,"useCustomMessageHeight",2),v([i()],H.prototype,"preferenceMaxMessageHeightMode",2),v([i()],H.prototype,"preferenceCustomMaxMessageHeight",2),v([i()],H.prototype,"preferenceCustomGridViewColumnWidth",2),v([i()],H.prototype,"preferenceCustomComparisonWidth",2),v([i()],H.prototype,"isAdvancedSectionCollapsed",2),v([i()],H.prototype,"isFocusModeSectionCollapsed",2),v([i()],H.prototype,"isGridView",2),v([o("#radio-group-max-message-height")],H.prototype,"radioGroupMaxMessageHeight",2),v([o("#radio-group-layout")],H.prototype,"radioGroupLayout",2),v([o("#popper-tooltip")],H.prototype,"popperTooltip",2),H=v([d("euphony-preference-window")],H);export{H as EuphonyPreferenceWindow};