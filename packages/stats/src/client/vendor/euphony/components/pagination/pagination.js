import{v as t,i as e,n as s,a,b as i,w as o}from"../../chunks/third-party.js";import{c as r}from"../../chunks/css/pagination.js";var g=Object.defineProperty,n=Object.getOwnPropertyDescriptor,p=(t,e,s,a)=>{for(var i,o=a>1?void 0:a?n(e,s):e,r=t.length-1;r>=0;r--)(i=t[r])&&(o=(a?i(e,s,o):i(o))||o);return a&&o&&g(e,s,o),o};let P=class extends a{constructor(){super(),this.curPage=1,this.totalPageNum=10,this.pageWindowSize=5,this.itemsPerPage=10,this.itemsPerPageOptions=[10,25,50,100],this.getPageButtonTemplate=t=>i` <button
      class="page-button"
      ?is-cur-page=${this.curPage===parseInt(t)}
      @click=${()=>{this.pageButtonClicked(t)}}
    >
      ${t}
    </button>`}willUpdate(t){if(t.has("itemsPerPage")&&!this.itemsPerPageOptions.includes(this.itemsPerPage)){const t=[...this.itemsPerPageOptions];t.push(this.itemsPerPage),t.sort((t,e)=>t-e),this.itemsPerPageOptions=t}}async initData(){}pageButtonClicked(t){let e=this.curPage;if("Prev"===t)this.curPage>1&&(e-=1);else if("Next"===t)this.curPage<this.totalPageNum&&(e+=1);else{const s=parseInt(t);this.curPage!==s&&(e=s)}const s=new CustomEvent("page-clicked",{detail:e,bubbles:!0,composed:!0});this.dispatchEvent(s)}itemsPerPageChanged(t){const e=t.target,s=parseInt(e.value);if(s!==this.itemsPerPage){this.itemsPerPage=s;const t=new CustomEvent("items-per-page-changed",{detail:s,bubbles:!0,composed:!0});this.dispatchEvent(t)}}render(){let t=i``;if(this.totalPageNum<=this.pageWindowSize)for(let e=0;e<Math.max(this.totalPageNum,1);e++)t=i`${t}
        ${this.getPageButtonTemplate(`${e+1}`)}`;else{const e=Math.floor((this.pageWindowSize-1)/2);let s=this.curPage-e,a=this.curPage+e;s<1?(s=1,a=this.pageWindowSize):a>this.totalPageNum&&(s=this.totalPageNum-this.pageWindowSize+1,a=this.totalPageNum),this.curPage>1&&(t=i`${t} ${this.getPageButtonTemplate("Prev")} `),s>1&&(t=i`${t} ${this.getPageButtonTemplate("1")}`,s>2&&(t=i`${t} <span>...</span>`));for(let e=s;e<a+1;e++)t=i`${t}
        ${this.getPageButtonTemplate(e.toString())} `;a<this.totalPageNum&&(a<this.totalPageNum-1&&(t=i`${t}<span>...</span>`),t=i`${t}
        ${this.getPageButtonTemplate(this.totalPageNum.toString())}`),this.curPage<this.totalPageNum&&(t=i`${t} ${this.getPageButtonTemplate("Next")} `)}const e=i`
      <div class="select-container">
        <span>Items per page:</span>
        <div class="item-select-wrapper">
          <select
            id="item-per-page-select"
            value="${this.itemsPerPage}"
            @change=${t=>{this.itemsPerPageChanged(t)}}
          >
            ${this.itemsPerPageOptions.map(t=>i`<option
                  value="${t}"
                  ?selected=${t==this.itemsPerPage}
                >
                  ${t}
                </option>`)}
          </select>
        </div>
      </div>
    `;return i`
      <div class="pagination">
        <div class="page-buttons">${t}</div>
        ${e}
      </div>
    `}};P.styles=[e`
      ${t(r)}
    `],p([s({type:Number})],P.prototype,"curPage",2),p([s({type:Number})],P.prototype,"totalPageNum",2),p([s({type:Number})],P.prototype,"pageWindowSize",2),p([s({type:Number})],P.prototype,"itemsPerPage",2),p([s({type:Array})],P.prototype,"itemsPerPageOptions",2),P=p([o("nightjar-pagination")],P);export{P as NightjarPagination};