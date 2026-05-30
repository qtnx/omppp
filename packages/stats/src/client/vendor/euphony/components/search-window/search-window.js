import{v as e,i as s,e as t,r as i,a,b as r,w as o}from"../../chunks/third-party.js";import{c as n}from"../../chunks/css/search-window.js";var l=Object.defineProperty,d=Object.getOwnPropertyDescriptor,c=(e,s,t,i)=>{for(var a,r=i>1?void 0:i?d(s,t):s,o=e.length-1;o>=0;o--)(a=e[o])&&(r=(i?a(s,t,r):a(r))||r);return i&&r&&l(s,t,r),r};const h=[{query:"[?metadata.adversarial==`false`]",description:'Find conversations whose ["metadata"]["adversarial"] is False'},{query:"[?contains(metadata.monster_meta.dataset_id, 'v7')]",description:'Find conversations whose ["metadata"]["monster_meta"]["dataset_id"] contains substring \'v7\''},{query:"[?metadata.count>`8` && contains(metadata.labels, 'K4')]",description:'Find conversations whose ["metadata"]["count"] is greater than 8 and ["metadata"]["labels"] list contains item "K4"'},{query:"[?messages[0].author.role=='assistant']",description:"Find conversations whose first message is from the assistant"}];let w=class extends a{constructor(){super(),this.showErrorMessage=!1,this.errorMessage=null,this.isOpen=!1,this.isSearching=!1,this.initData=async()=>{}}firstUpdated(){window.setTimeout(()=>{},1e3)}willUpdate(e){}show(){this.isOpen=!0}close(){this.isOpen=!1}searchSucceeded(){this.showErrorMessage=!1,this.isSearching=!1,this.errorMessage=null,this.close();const e=this.shadowRoot?.querySelector("textarea");e&&(e.value="")}searchFailed(e){this.errorMessage=e,this.showErrorMessage=!0,this.isSearching=!1}isQueryValid(e){return null!==/^\[\?.*\]$/.exec(e)}cancelClicked(e){e.stopPropagation(),!this.isSearching&&this.close()}confirmClicked(e){if(e.stopPropagation(),this.isSearching)return;const s=this.shadowRoot?.querySelector("textarea");if(!s)throw new Error("Text area not found");const t=s.value;if(!this.isQueryValid(t))return this.errorMessage="Make sure your query is formatted as [?expression]",void(this.showErrorMessage=!0);this.showErrorMessage=!1,this.isSearching=!0;const i=new CustomEvent("search-query-submitted",{bubbles:!0,composed:!0,detail:t});this.dispatchEvent(i)}onDragStart(e){if(e.preventDefault(),!this.windowElement)throw new Error("Window element not found");if(this.windowElement.style.top.includes("%")){const e=this.windowElement.clientHeight,s=this.windowElement.clientWidth,t=(window.innerHeight-e)/2,i=(window.innerWidth-s)/2;this.windowElement.style.top=`${t}px`,this.windowElement.style.left=`${i}px`,this.windowElement.style.transform=""}const s=e.clientX,t=e.clientY,i=this.windowElement.offsetTop,a=this.windowElement.offsetLeft,r=e=>{const r=e.clientX-s,o=e.clientY-t;this.windowElement.style.top=`${i+o}px`,this.windowElement.style.left=`${a+r}px`},o=()=>{window.removeEventListener("mousemove",r),window.removeEventListener("mouseup",o)};window.addEventListener("mousemove",r),window.addEventListener("mouseup",o)}render(){let e=r``;for(const s of h)e=r`${e}
        <li class="example-item">
          <div class="example-description">${s.description}</div>
          <pre class="example-query">${s.query}</pre>
        </li> `;return r`
      <div class="back-drop" ?open=${this.isOpen}></div>
      <div class="search-window" ?open=${this.isOpen}>
        <div
          class="header"
          @mousedown=${e=>{this.onDragStart(e)}}
        >
          <div class="header-name">Filter data</div>
        </div>

        <div class="content">
          <div class="message">
            Use
            <a href="https://jmespath.org/tutorial.html" target="_blank"
              >JMESPath query</a
            >
            to filter conversation data
          </div>

          <div class="query-example">
            <div class="example-label">Examples</div>
            <ul class="example-list">
              ${e}
            </ul>
          </div>

          <textarea
            class="query-input"
            rows="3"
            spellcheck="false"
            placeholder="[?metadata.adversarial==\`false\`]"
            @keydown=${e=>{e.stopPropagation()}}
          ></textarea>
        </div>

        <div class="footer">
          <div class="left-block">
            <!-- Important to avoid new line and whitespace here -->
            <!-- prettier-ignore -->
            <div class="error-message" ?no-show=${!this.showErrorMessage}>${this.errorMessage}</div>

            <div class="loader-container" ?is-loading=${this.isSearching}>
              <div class="loader-label">Filtering</div>
              <div class="loader"></div>
            </div>
          </div>

          <div class="button-block">
            <button
              class="cancel-button"
              @click=${e=>{this.cancelClicked(e)}}
            >
              Cancel
            </button>
            <button
              class="confirm-button"
              ?is-searching=${this.isSearching}
              @click=${e=>{this.confirmClicked(e)}}
            >
              Filter
            </button>
          </div>
        </div>
      </div>
    `}};w.styles=[s`
      ${e(n)}
    `],c([t("div.search-window")],w.prototype,"windowElement",2),c([i()],w.prototype,"showErrorMessage",2),c([i()],w.prototype,"errorMessage",2),c([i()],w.prototype,"isOpen",2),c([i()],w.prototype,"isSearching",2),w=c([o("euphony-search-window")],w);export{w as EuphonySearchWindow};