javascript:(function() {
    // --- Modules ---
    const Readability = (function() {
      // ... [Readability code from your gist, with modifications] ... 
      /**
 * Public constructor.
 * @param {HTMLDocument} doc     The document to parse.
 * @param {Object}       options The options object.
 */
function Readability(doc, options) {
    // In some older versions, people passed a URI as the first argument. Cope:
    if (options && options.documentElement) {
      doc = options;
      options = arguments[2];
    } else if (!doc || !doc.documentElement) {
      throw new Error(
        'First argument to Readability constructor should be a document object.',
      );
    }
    options = options || {};
  
    this._doc = doc;
    this._docJSDOMParser = this._doc.firstChild.__JSDOMParser__;
    this._articleTitle = null;
    this._articleByline = null;
    this._articleDir = null;
    this._articleSiteName = null;
    this._attempts = [];
  
    // Configurable options
    this._debug = !!options.debug;
    this._maxElemsToParse =
      options.maxElemsToParse || this.DEFAULT_MAX_ELEMS_TO_PARSE;
    this._nbTopCandidates =
      options.nbTopCandidates || this.DEFAULT_N_TOP_CANDIDATES;
    this._charThreshold = options.charThreshold || this.DEFAULT_CHAR_THRESHOLD;
    this._classesToPreserve = this.CLASSES_TO_PRESERVE.concat(
      options.classesToPreserve || [],
    );
    this._keepClasses = !!options.keepClasses;
  
    // Start with all flags set
    this._flags =
      this.FLAG_STRIP_UNLIKELYS |
      this.FLAG_WEIGHT_CLASSES |
      this.FLAG_CLEAN_CONDITIONALLY;
  
    let logEl;
  
    // Control whether log messages are sent to the console
    if (this._debug) {
      logEl = function (e) {
        const rv = e.nodeName + ' ';
        if (e.nodeType == e.TEXT_NODE) {
          return rv + '("' + e.textContent + '")';
        }
        const classDesc = e.className && '.' + e.className.replace(/ /g, '.');
        let elDesc = '';
        if (e.id) {
          elDesc = '(#' + e.id + classDesc + ')';
        } else if (classDesc) {
          elDesc = '(' + classDesc + ')';
        }
        return rv + elDesc;
      };
      this.log = function () {
        if (typeof dump !== 'undefined') {
          const msg = Array.prototype.map
            .call(arguments, (x) => (x && x.nodeName ? logEl(x) : x))
            .join(' ');
          dump('Reader: (Readability) ' + msg + '\n');
        } else if (typeof console !== 'undefined') {
          const args = ['Reader: (Readability) '].concat(arguments);
          console.log.apply(console, args);
        }
      };
    } else {
      this.log = function () {};
    }
  }
  
  Readability.prototype = {
    FLAG_STRIP_UNLIKELYS: 0x1,
    FLAG_WEIGHT_CLASSES: 0x2,
    FLAG_CLEAN_CONDITIONALLY: 0x4,
  
    // https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
    ELEMENT_NODE: 1,
    TEXT_NODE: 3,
  
    // Max number of nodes supported by this parser. Default: 0 (no limit)
    DEFAULT_MAX_ELEMS_TO_PARSE: 0,
  
    // The number of top candidates to consider when analysing how
    // tight the competition is among candidates.
    DEFAULT_N_TOP_CANDIDATES: 5,
  
    // Element tags to score by default.
    DEFAULT_TAGS_TO_SCORE: 'section,h2,h3,h4,h5,h6,p,td,pre'
      .toUpperCase()
      .split(','),
  
    // The default number of chars an article must have in order to return a result
    DEFAULT_CHAR_THRESHOLD: 500,
  
    // All of the regular expressions in use within readability.
    // Defined up here so we don't instantiate them repeatedly in loops.
    REGEXPS: {
      // NOTE: These two regular expressions are duplicated in
      // Readability-readerable.js. Please keep both copies in sync.
      unlikelyCandidates:
        /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
      okMaybeItsACandidate: /and|article|body|column|content|main|shadow/i,
  
      positive:
        /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
      negative:
        /hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i,
      extraneous:
        /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single|utility/i,
      byline: /byline|author|dateline|writtenby|p-author/i,
      replaceFonts: /<(\/?)font[^>]*>/gi,
      normalize: /\s{2,}/g,
      videos:
        /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
      shareElements: /(\b|_)(share|sharedaddy)(\b|_)/i,
      nextLink: /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i,
      prevLink: /(prev|earl|old|new|<|«)/i,
      whitespace: /^\s*$/,
      hasContent: /\S$/,
      srcsetUrl: /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g,
      b64DataUrl: /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i,
    },
  
    DIV_TO_P_ELEMS: [
      'A',
      'BLOCKQUOTE',
      'DL',
      'DIV',
      'IMG',
      'OL',
      'P',
      'PRE',
      'TABLE',
      'UL',
      'SELECT',
    ],
  
    ALTER_TO_DIV_EXCEPTIONS: ['DIV', 'ARTICLE', 'SECTION', 'P'],
  
    PRESENTATIONAL_ATTRIBUTES: [
      'align',
      'background',
      'bgcolor',
      'border',
      'cellpadding',
      'cellspacing',
      'frame',
      'hspace',
      'rules',
      'style',
      'valign',
      'vspace',
    ],
  
    DEPRECATED_SIZE_ATTRIBUTE_ELEMS: ['TABLE', 'TH', 'TD', 'HR', 'PRE'],
  
    // The commented out elements qualify as phrasing content but tend to be
    // removed by readability when put into paragraphs, so we ignore them here.
    PHRASING_ELEMS: [
      // "CANVAS", "IFRAME", "SVG", "VIDEO",
      'ABBR',
      'AUDIO',
      'B',
      'BDO',
      'BR',
      'BUTTON',
      'CITE',
      'CODE',
      'DATA',
      'DATALIST',
      'DFN',
      'EM',
      'EMBED',
      'I',
      'IMG',
      'INPUT',
      'KBD',
      'LABEL',
      'MARK',
      'MATH',
      'METER',
      'NOSCRIPT',
      'OBJECT',
      'OUTPUT',
      'PROGRESS',
      'Q',
      'RUBY',
      'SAMP',
      'SCRIPT',
      'SELECT',
      'SMALL',
      'SPAN',
      'STRONG',
      'SUB',
      'SUP',
      'TEXTAREA',
      'TIME',
      'VAR',
      'WBR',
    ],
  
    // These are the classes that readability sets itself.
    CLASSES_TO_PRESERVE: ['page'],
  
    // These are the list of HTML entities that need to be escaped.
    HTML_ESCAPE_MAP: {
      lt: '<',
      gt: '>',
      amp: '&',
      quot: '"',
      apos: "'",
    },
  
    /**
     * Run any post-process modifications to article content as necessary.
     *
     * @param Element
     * @return void
     **/
    _postProcessContent(articleContent) {
      // Readability cannot open relative uris so we convert them to absolute uris.
      this._fixRelativeUris(articleContent);
  
      if (!this._keepClasses) {
        // Remove classes.
        this._cleanClasses(articleContent);
      }
    },
  
    /**
     * Iterates over a NodeList, calls `filterFn` for each node and removes node
     * if function returned `true`.
     *
     * If function is not passed, removes all the nodes in node list.
     *
     * @param NodeList nodeList The nodes to operate on
     * @param Function filterFn the function to use as a filter
     * @return void
     */
    _removeNodes(nodeList, filterFn) {
      // Avoid ever operating on live node lists.
      if (this._docJSDOMParser && nodeList._isLiveNodeList) {
        throw new Error('Do not pass live node lists to _removeNodes');
      }
      for (let i = nodeList.length - 1; i >= 0; i--) {
        const node = nodeList[i];
        const parentNode = node.parentNode;
        if (parentNode) {
          if (!filterFn || filterFn.call(this, node, i, nodeList)) {
            parentNode.removeChild(node);
          }
        }
      }
    },
  
    /**
     * Iterates over a NodeList, and calls _setNodeTag for each node.
     *
     * @param NodeList nodeList The nodes to operate on
     * @param String newTagName the new tag name to use
     * @return void
     */
    _replaceNodeTags(nodeList, newTagName) {
      // Avoid ever operating on live node lists.
      if (this._docJSDOMParser && nodeList._isLiveNodeList) {
        throw new Error('Do not pass live node lists to _replaceNodeTags');
      }
      for (let i = nodeList.length - 1; i >= 0; i--) {
        const node = nodeList[i];
        this._setNodeTag(node, newTagName);
      }
    },
  
    /**
     * Iterate over a NodeList, which doesn't natively fully implement the Array
     * interface.
     *
     * For convenience, the current object context is applied to the provided
     * iterate function.
     *
     * @param  NodeList nodeList The NodeList.
     * @param  Function fn       The iterate function.
     * @return void
     */
    _forEachNode(nodeList, fn) {
      Array.prototype.forEach.call(nodeList, fn, this);
    },
  
    /**
     * Iterate over a NodeList, return true if any of the provided iterate
     * function calls returns true, false otherwise.
     *
     * For convenience, the current object context is applied to the
     * provided iterate function.
     *
     * @param  NodeList nodeList The NodeList.
     * @param  Function fn       The iterate function.
     * @return Boolean
     */
    _someNode(nodeList, fn) {
      return Array.prototype.some.call(nodeList, fn, this);
    },
  
    /**
     * Iterate over a NodeList, return true if all of the provided iterate
     * function calls return true, false otherwise.
     *
     * For convenience, the current object context is applied to the
     * provided iterate function.
     *
     * @param  NodeList nodeList The NodeList.
     * @param  Function fn       The iterate function.
     * @return Boolean
     */
    _everyNode(nodeList, fn) {
      return Array.prototype.every.call(nodeList, fn, this);
    },
  
    /**
     * Concat all nodelists passed as arguments.
     *
     * @return ...NodeList
     * @return Array
     */
    _concatNodeLists() {
      const slice = Array.prototype.slice;
      const args = slice.call(arguments);
      const nodeLists = args.map((list) => slice.call(list));
      return Array.prototype.concat.apply([], nodeLists);
    },
  
    _getAllNodesWithTag(node, tagNames) {
      if (node.querySelectorAll) {
        return node.querySelectorAll(tagNames.join(','));
      }
      return [].concat.apply(
        [],
        tagNames.map((tag) => {
          const collection = node.getElementsByTagName(tag);
          return Array.isArray(collection) ? collection : Array.from(collection);
        }),
      );
    },
  
    /**
     * Removes the class="" attribute from every element in the given
     * subtree, except those that match CLASSES_TO_PRESERVE and
     * the classesToPreserve array from the options object.
     *
     * @param Element
     * @return void
     */
    _cleanClasses(node) {
      const classesToPreserve = this._classesToPreserve;
      const className = (node.getAttribute('class') || '')
        .split(/\s+/)
        .filter((cls) => classesToPreserve.indexOf(cls) != -1)
        .join(' ');
  
      if (className) {
        node.setAttribute('class', className);
      } else {
        node.removeAttribute('class');
      }
  
      for (node = node.firstElementChild; node; node = node.nextElementSibling) {
        this._cleanClasses(node);
      }
    },
  
    /**
     * Converts each <a> and <img> uri in the given element to an absolute URI,
     * ignoring #ref URIs.
     *
     * @param Element
     * @return void
     */
    _fixRelativeUris(articleContent) {
      const baseURI = this._doc.baseURI;
      const documentURI = this._doc.documentURI;
      function toAbsoluteURI(uri) {
        // Leave hash links alone if the base URI matches the document URI:
        if (baseURI == documentURI && uri.charAt(0) == '#') {
          return uri;
        }
  
        // Otherwise, resolve against base URI:
        try {
          return new URL(uri, baseURI).href;
        } catch (ex) {
          // Something went wrong, just return the original:
        }
        return uri;
      }
  
      const links = this._getAllNodesWithTag(articleContent, ['a']);
      this._forEachNode(links, function (link) {
        const href = link.getAttribute('href');
        if (href) {
          // Remove links with javascript: URIs, since
          // they won't work after scripts have been removed from the page.
          if (href.indexOf('javascript:') === 0) {
            // if the link only contains simple text content, it can be converted to a text node
            if (
              link.childNodes.length === 1 &&
              link.childNodes[0].nodeType === this.TEXT_NODE
            ) {
              const text = this._doc.createTextNode(link.textContent);
              link.parentNode.replaceChild(text, link);
            } else {
              // if the link has multiple children, they should all be preserved
              const container = this._doc.createElement('span');
              while (link.childNodes.length > 0) {
                container.appendChild(link.childNodes[0]);
              }
              link.parentNode.replaceChild(container, link);
            }
          } else {
            link.setAttribute('href', toAbsoluteURI(href));
          }
        }
      });
  
      const medias = this._getAllNodesWithTag(articleContent, [
        'img',
        'picture',
        'figure',
        'video',
        'audio',
        'source',
      ]);
  
      this._forEachNode(medias, function (media) {
        const src = media.getAttribute('src');
        const poster = media.getAttribute('poster');
        const srcset = media.getAttribute('srcset');
  
        if (src) {
          media.setAttribute('src', toAbsoluteURI(src));
        }
  
        if (poster) {
          media.setAttribute('poster', toAbsoluteURI(poster));
        }
  
        if (srcset) {
          const newSrcset = srcset.replace(
            this.REGEXPS.srcsetUrl,
            (_, p1, p2, p3) => toAbsoluteURI(p1) + (p2 || '') + p3,
          );
  
          media.setAttribute('srcset', newSrcset);
        }
      });
    },
  
    /**
     * Get the article title as an H1.
     *
     * @return void
     **/
    _getArticleTitle() {
      const doc = this._doc;
      let curTitle = '';
      let origTitle = '';
  
      try {
        curTitle = origTitle = doc.title.trim();
  
        // If they had an element with id "title" in their HTML
        if (typeof curTitle !== 'string') {
          curTitle = origTitle = this._getInnerText(
            doc.getElementsByTagName('title')[0],
          );
        }
      } catch (e) {
        /* ignore exceptions setting the title. */
      }
  
      let titleHadHierarchicalSeparators = false;
      function wordCount(str) {
        return str.split(/\s+/).length;
      }
  
      // If there's a separator in the title, first remove the final part
      if (/ [\|\-\\\/>»] /.test(curTitle)) {
        titleHadHierarchicalSeparators = / [\\\/>»] /.test(curTitle);
        curTitle = origTitle.replace(/(.*)[\|\-\\\/>»] .*/gi, '$1');
  
        // If the resulting title is too short (3 words or fewer), remove
        // the first part instead:
        if (wordCount(curTitle) < 3) {
          curTitle = origTitle.replace(/[^\|\-\\\/>»]*[\|\-\\\/>»](.*)/gi, '$1');
        }
      } else if (curTitle.indexOf(': ') !== -1) {
        // Check if we have an heading containing this exact string, so we
        // could assume it's the full title.
        const headings = this._concatNodeLists(
          doc.getElementsByTagName('h1'),
          doc.getElementsByTagName('h2'),
        );
        const trimmedTitle = curTitle.trim();
        const match = this._someNode(
          headings,
          (heading) => heading.textContent.trim() === trimmedTitle,
        );
  
        // If we don't, let's extract the title out of the original title string.
        if (!match) {
          curTitle = origTitle.substring(origTitle.lastIndexOf(':') + 1);
  
          // If the title is now too short, try the first colon instead:
          if (wordCount(curTitle) < 3) {
            curTitle = origTitle.substring(origTitle.indexOf(':') + 1);
            // But if we have too many words before the colon there's something weird
            // with the titles and the H tags so let's just use the original title instead
          } else if (wordCount(origTitle.substr(0, origTitle.indexOf(':'))) > 5) {
            curTitle = origTitle;
          }
        }
      } else if (curTitle.length > 150 || curTitle.length < 15) {
        const hOnes = doc.getElementsByTagName('h1');
  
        if (hOnes.length === 1) {
          curTitle = this._getInnerText(hOnes[0]);
        }
      }
  
      curTitle = curTitle.trim().replace(this.REGEXPS.normalize, ' ');
      // If we now have 4 words or fewer as our title, and either no
      // 'hierarchical' separators (\, /, > or ») were found in the original
      // title or we decreased the number of words by more than 1 word, use
      // the original title.
      const curTitleWordCount = wordCount(curTitle);
      if (
        curTitleWordCount <= 4 &&
        (!titleHadHierarchicalSeparators ||
          curTitleWordCount !=
          wordCount(origTitle.replace(/[\|\-\\\/>»]+/g, '')) - 1)
      ) {
        curTitle = origTitle;
      }
  
      return curTitle;
    },
  
    /**
     * Prepare the HTML document for readability to scrape it.
     * This includes things like stripping javascript, CSS, and handling terrible markup.
     *
     * @return void
     **/
    _prepDocument() {
      const doc = this._doc;
  
      // Remove all style tags in head
      this._removeNodes(this._getAllNodesWithTag(doc, ['style']));
  
      if (doc.body) {
        this._replaceBrs(doc.body);
      }
  
      this._replaceNodeTags(this._getAllNodesWithTag(doc, ['font']), 'SPAN');
    },
  
    /**
     * Finds the next element, starting from the given node, and ignoring
     * whitespace in between. If the given node is an element, the same node is
     * returned.
     */
    _nextElement(node) {
      let next = node;
      while (
        next &&
        next.nodeType != this.ELEMENT_NODE &&
        this.REGEXPS.whitespace.test(next.textContent)
        ) {
        next = next.nextSibling;
      }
      return next;
    },
  
    /**
     * Replaces 2 or more successive <br> elements with a single <p>.
     * Whitespace between <br> elements are ignored. For example:
     *   <div>foo<br>bar<br> <br><br>abc</div>
     * will become:
     *   <div>foo<br>bar<p>abc</p></div>
     */
    _replaceBrs(elem) {
      this._forEachNode(this._getAllNodesWithTag(elem, ['br']), function (br) {
        let next = br.nextSibling;
  
        // Whether 2 or more <br> elements have been found and replaced with a
        // <p> block.
        let replaced = false;
  
        // If we find a <br> chain, remove the <br>s until we hit another element
        // or non-whitespace. This leaves behind the first <br> in the chain
        // (which will be replaced with a <p> later).
        while ((next = this._nextElement(next)) && next.tagName == 'BR') {
          replaced = true;
          const brSibling = next.nextSibling;
          next.parentNode.removeChild(next);
          next = brSibling;
        }
  
        // If we removed a <br> chain, replace the remaining <br> with a <p>. Add
        // all sibling nodes as children of the <p> until we hit another <br>
        // chain.
        if (replaced) {
          const p = this._doc.createElement('p');
          br.parentNode.replaceChild(p, br);
  
          next = p.nextSibling;
          while (next) {
            // If we've hit another <br><br>, we're done adding children to this <p>.
            if (next.tagName == 'BR') {
              const nextElem = this._nextElement(next.nextSibling);
              if (nextElem && nextElem.tagName == 'BR') {
                break;
              }
            }
  
            if (!this._isPhrasingContent(next)) {
              break;
            }
  
            // Otherwise, make this node a child of the new <p>.
            const sibling = next.nextSibling;
            p.appendChild(next);
            next = sibling;
          }
  
          while (p.lastChild && this._isWhitespace(p.lastChild)) {
            p.removeChild(p.lastChild);
          }
  
          if (p.parentNode.tagName === 'P') {
            this._setNodeTag(p.parentNode, 'DIV');
          }
        }
      });
    },
  
    _setNodeTag(node, tag) {
      this.log('_setNodeTag', node, tag);
      if (this._docJSDOMParser) {
        node.localName = tag.toLowerCase();
        node.tagName = tag.toUpperCase();
        return node;
      }
  
      const replacement = node.ownerDocument.createElement(tag);
      while (node.firstChild) {
        replacement.appendChild(node.firstChild);
      }
      node.parentNode.replaceChild(replacement, node);
      if (node.readability) {
        replacement.readability = node.readability;
      }
  
      for (let i = 0; i < node.attributes.length; i++) {
        try {
          replacement.setAttribute(
            node.attributes[i].name,
            node.attributes[i].value,
          );
        } catch (ex) {
          /* it's possible for setAttribute() to throw if the attribute name
           * isn't a valid XML Name. Such attributes can however be parsed from
           * source in HTML docs, see https://github.com/whatwg/html/issues/4275,
           * so we can hit them here and then throw. We don't care about such
           * attributes so we ignore them.
           */
        }
      }
      return replacement;
    },
  
    /**
     * Prepare the article node for display. Clean out any inline styles,
     * iframes, forms, strip extraneous <p> tags, etc.
     *
     * @param Element
     * @return void
     **/
    _prepArticle(articleContent) {
      this._cleanStyles(articleContent);
  
      // Check for data tables before we continue, to avoid removing items in
      // those tables, which will often be isolated even though they're
      // visually linked to other content-ful elements (text, images, etc.).
      this._markDataTables(articleContent);
  
      this._fixLazyImages(articleContent);
  
      // Clean out junk from the article content
      this._cleanConditionally(articleContent, 'form');
      this._cleanConditionally(articleContent, 'fieldset');
      this._clean(articleContent, 'object');
      this._clean(articleContent, 'embed');
      this._clean(articleContent, 'h1');
      this._clean(articleContent, 'footer');
      this._clean(articleContent, 'link');
      this._clean(articleContent, 'aside');
  
      // Clean out elements with little content that have "share" in their id/class combinations from final top candidates,
      // which means we don't remove the top candidates even they have "share".
  
      const shareElementThreshold = this.DEFAULT_CHAR_THRESHOLD;
  
      this._forEachNode(articleContent.children, function (topCandidate) {
        this._cleanMatchedNodes(topCandidate, function (node, matchString) {
          return (
            this.REGEXPS.shareElements.test(matchString) &&
            node.textContent.length < shareElementThreshold
          );
        });
      });
  
      // If there is only one h2 and its text content substantially equals article title,
      // they are probably using it as a header and not a subheader,
      // so remove it since we already extract the title separately.
      const h2 = articleContent.getElementsByTagName('h2');
      if (h2.length === 1) {
        const lengthSimilarRate =
          (h2[0].textContent.length - this._articleTitle.length) /
          this._articleTitle.length;
        if (Math.abs(lengthSimilarRate) < 0.5) {
          let titlesMatch = false;
          if (lengthSimilarRate > 0) {
            titlesMatch = h2[0].textContent.includes(this._articleTitle);
          } else {
            titlesMatch = this._articleTitle.includes(h2[0].textContent);
          }
          if (titlesMatch) {
            this._clean(articleContent, 'h2');
          }
        }
      }
  
      this._clean(articleContent, 'iframe');
      this._clean(articleContent, 'input');
      this._clean(articleContent, 'textarea');
      this._clean(articleContent, 'select');
      this._clean(articleContent, 'button');
      this._cleanHeaders(articleContent);
  
      // Do these last as the previous stuff may have removed junk
      // that will affect these
      this._cleanConditionally(articleContent, 'table');
      this._cleanConditionally(articleContent, 'ul');
      this._cleanConditionally(articleContent, 'div');
  
      // Remove extra paragraphs
      this._removeNodes(
        this._getAllNodesWithTag(articleContent, ['p']),
        function (paragraph) {
          const imgCount = paragraph.getElementsByTagName('img').length;
          const embedCount = paragraph.getElementsByTagName('embed').length;
          const objectCount = paragraph.getElementsByTagName('object').length;
          // At this point, nasty iframes have been removed, only remain embedded video ones.
          const iframeCount = paragraph.getElementsByTagName('iframe').length;
          const totalCount = imgCount + embedCount + objectCount + iframeCount;
  
          return totalCount === 0 && !this._getInnerText(paragraph, false);
        },
      );
  
      this._forEachNode(
        this._getAllNodesWithTag(articleContent, ['br']),
        function (br) {
          const next = this._nextElement(br.nextSibling);
          if (next && next.tagName == 'P') {
            br.parentNode.removeChild(br);
          }
        },
      );
  
      // Remove single-cell tables
      this._forEachNode(
        this._getAllNodesWithTag(articleContent, ['table']),
        function (table) {
          const tbody = this._hasSingleTagInsideElement(table, 'TBODY')
            ? table.firstElementChild
            : table;
          if (this._hasSingleTagInsideElement(tbody, 'TR')) {
            const row = tbody.firstElementChild;
            if (this._hasSingleTagInsideElement(row, 'TD')) {
              let cell = row.firstElementChild;
              cell = this._setNodeTag(
                cell,
                this._everyNode(cell.childNodes, this._isPhrasingContent)
                  ? 'P'
                  : 'DIV',
              );
              table.parentNode.replaceChild(cell, table);
            }
          }
        },
      );
    },
  
    /**
     * Initialize a node with the readability object. Also checks the
     * className/id for special names to add to its score.
     *
     * @param Element
     * @return void
     **/
    _initializeNode(node) {
      node.readability = {contentScore: 0};
  
      switch (node.tagName) {
        case 'DIV':
          node.readability.contentScore += 5;
          break;
  
        case 'PRE':
        case 'TD':
        case 'BLOCKQUOTE':
          node.readability.contentScore += 3;
          break;
  
        case 'ADDRESS':
        case 'OL':
        case 'UL':
        case 'DL':
        case 'DD':
        case 'DT':
        case 'LI':
        case 'FORM':
          node.readability.contentScore -= 3;
          break;
  
        case 'H1':
        case 'H2':
        case 'H3':
        case 'H4':
        case 'H5':
        case 'H6':
        case 'TH':
          node.readability.contentScore -= 5;
          break;
      }
  
      node.readability.contentScore += this._getClassWeight(node);
    },
  
    _removeAndGetNext(node) {
      const nextNode = this._getNextNode(node, true);
      node.parentNode.removeChild(node);
      return nextNode;
    },
  
    /**
     * Traverse the DOM from node to node, starting at the node passed in.
     * Pass true for the second parameter to indicate this node itself
     * (and its kids) are going away, and we want the next node over.
     *
     * Calling this in a loop will traverse the DOM depth-first.
     */
    _getNextNode(node, ignoreSelfAndKids) {
      // First check for kids if those aren't being ignored
      if (!ignoreSelfAndKids && node.firstElementChild) {
        return node.firstElementChild;
      }
      // Then for siblings...
      if (node.nextElementSibling) {
        return node.nextElementSibling;
      }
      // And finally, move up the parent chain *and* find a sibling
      // (because this is depth-first traversal, we will have already
      // seen the parent nodes themselves).
      do {
        node = node.parentNode;
      } while (node && !node.nextElementSibling);
      return node && node.nextElementSibling;
    },
  
    _checkByline(node, matchString) {
      if (this._articleByline) {
        return false;
      }
  
      if (node.getAttribute !== undefined) {
        var rel = node.getAttribute('rel');
        var itemprop = node.getAttribute('itemprop');
      }
  
      if (
        (rel === 'author' ||
          (itemprop && itemprop.indexOf('author') !== -1) ||
          this.REGEXPS.byline.test(matchString)) &&
        this._isValidByline(node.textContent)
      ) {
        this._articleByline = node.textContent.trim();
        return true;
      }
  
      return false;
    },
  
    _getNodeAncestors(node, maxDepth) {
      maxDepth = maxDepth || 0;
      let i = 0,
        ancestors = [];
      while (node.parentNode) {
        ancestors.push(node.parentNode);
        if (maxDepth && ++i === maxDepth) {
          break;
        }
        node = node.parentNode;
      }
      return ancestors;
    },
  
    /** *
     * grabArticle - Using a variety of metrics (content score, classname, element types), find the content that is
     *         most likely to be the stuff a user wants to read. Then return it wrapped up in a div.
     *
     * @param page a document to run upon. Needs to be a full document, complete with body.
     * @return Element
     **/
    _grabArticle(page) {
      this.log('**** grabArticle ****');
      const doc = this._doc;
      const isPaging = page !== null;
      page = page ? page : this._doc.body;
  
      // We can't grab an article if we don't have a page!
      if (!page) {
        this.log('No body found in document. Abort.');
        return null;
      }
  
      const pageCacheHtml = page.innerHTML;
  
      while (true) {
        const stripUnlikelyCandidates = this._flagIsActive(
          this.FLAG_STRIP_UNLIKELYS,
        );
  
        // First, node prepping. Trash nodes that look cruddy (like ones with the
        // class name "comment", etc), and turn divs into P tags where they have been
        // used inappropriately (as in, where they contain no other block level elements.)
        const elementsToScore = [];
        let node = this._doc.documentElement;
  
        while (node) {
          const matchString = node.className + ' ' + node.id;
  
          if (!this._isProbablyVisible(node)) {
            this.log('Removing hidden node - ' + matchString);
            node = this._removeAndGetNext(node);
            continue;
          }
  
          // Check to see if this node is a byline, and remove it if it is.
          if (this._checkByline(node, matchString)) {
            node = this._removeAndGetNext(node);
            continue;
          }
  
          // Remove unlikely candidates
          if (stripUnlikelyCandidates) {
            if (
              this.REGEXPS.unlikelyCandidates.test(matchString) &&
              !this.REGEXPS.okMaybeItsACandidate.test(matchString) &&
              !this._hasAncestorTag(node, 'table') &&
              node.tagName !== 'BODY' &&
              node.tagName !== 'A'
            ) {
              this.log('Removing unlikely candidate - ' + matchString);
              node = this._removeAndGetNext(node);
              continue;
            }
  
            if (node.getAttribute('role') == 'complementary') {
              this.log('Removing complementary content - ' + matchString);
              node = this._removeAndGetNext(node);
              continue;
            }
          }
  
          // Remove DIV, SECTION, and HEADER nodes without any content(e.g. text, image, video, or iframe).
          if (
            (node.tagName === 'DIV' ||
              node.tagName === 'SECTION' ||
              node.tagName === 'HEADER' ||
              node.tagName === 'H1' ||
              node.tagName === 'H2' ||
              node.tagName === 'H3' ||
              node.tagName === 'H4' ||
              node.tagName === 'H5' ||
              node.tagName === 'H6') &&
            this._isElementWithoutContent(node)
          ) {
            node = this._removeAndGetNext(node);
            continue;
          }
  
          if (this.DEFAULT_TAGS_TO_SCORE.indexOf(node.tagName) !== -1) {
            elementsToScore.push(node);
          }
  
          // Turn all divs that don't have children block level elements into p's
          if (node.tagName === 'DIV') {
            // Put phrasing content into paragraphs.
            let p = null;
            let childNode = node.firstChild;
            while (childNode) {
              const nextSibling = childNode.nextSibling;
              if (this._isPhrasingContent(childNode)) {
                if (p !== null) {
                  p.appendChild(childNode);
                } else if (!this._isWhitespace(childNode)) {
                  p = doc.createElement('p');
                  node.replaceChild(p, childNode);
                  p.appendChild(childNode);
                }
              } else if (p !== null) {
                while (p.lastChild && this._isWhitespace(p.lastChild)) {
                  p.removeChild(p.lastChild);
                }
                p = null;
              }
              childNode = nextSibling;
            }
  
            // Sites like http://mobile.slate.com encloses each paragraph with a DIV
            // element. DIVs with only a P element inside and no text content can be
            // safely converted into plain P elements to avoid confusing the scoring
            // algorithm with DIVs with are, in practice, paragraphs.
            if (
              this._hasSingleTagInsideElement(node, 'P') &&
              this._getLinkDensity(node) < 0.25
            ) {
              const newNode = node.children[0];
              node.parentNode.replaceChild(newNode, node);
              node = newNode;
              elementsToScore.push(node);
            } else if (!this._hasChildBlockElement(node)) {
              node = this._setNodeTag(node, 'P');
              elementsToScore.push(node);
            }
          }
          node = this._getNextNode(node);
        }
  
        /**
         * Loop through all paragraphs, and assign a score to them based on how content-y they look.
         * Then add their score to their parent node.
         *
         * A score is determined by things like number of commas, class names, etc. Maybe eventually link density.
         **/
        var candidates = [];
        this._forEachNode(elementsToScore, function (elementToScore) {
          if (
            !elementToScore.parentNode ||
            typeof elementToScore.parentNode.tagName === 'undefined'
          ) {
            return;
          }
  
          // If this paragraph is less than 25 characters, don't even count it.
          const innerText = this._getInnerText(elementToScore);
          if (innerText.length < 25) {
            return;
          }
  
          // Exclude nodes with no ancestor.
          const ancestors = this._getNodeAncestors(elementToScore, 3);
          if (ancestors.length === 0) {
            return;
          }
  
          let contentScore = 0;
  
          // Add a point for the paragraph itself as a base.
          contentScore += 1;
  
          // Add points for any commas within this paragraph.
          contentScore += innerText.split(',').length;
  
          // For every 100 characters in this paragraph, add another point. Up to 3 points.
          contentScore += Math.min(Math.floor(innerText.length / 100), 3);
  
          // Initialize and score ancestors.
          this._forEachNode(ancestors, function (ancestor, level) {
            if (
              !ancestor.tagName ||
              !ancestor.parentNode ||
              typeof ancestor.parentNode.tagName === 'undefined'
            ) {
              return;
            }
  
            if (typeof ancestor.readability === 'undefined') {
              this._initializeNode(ancestor);
              candidates.push(ancestor);
            }
  
            // Node score divider:
            // - parent:             1 (no division)
            // - grandparent:        2
            // - great grandparent+: ancestor level * 3
            if (level === 0) {
              var scoreDivider = 1;
            } else if (level === 1) {
              scoreDivider = 2;
            } else {
              scoreDivider = level * 3;
            }
            ancestor.readability.contentScore += contentScore / scoreDivider;
          });
        });
  
        // After we've calculated scores, loop through all of the possible
        // candidate nodes we found and find the one with the highest score.
        const topCandidates = [];
        for (let c = 0, cl = candidates.length; c < cl; c += 1) {
          const candidate = candidates[c];
  
          // Scale the final candidates score based on link density. Good content
          // should have a relatively small link density (5% or less) and be mostly
          // unaffected by this operation.
          const candidateScore =
            candidate.readability.contentScore *
            (1 - this._getLinkDensity(candidate));
          candidate.readability.contentScore = candidateScore;
  
          this.log('Candidate:', candidate, 'with score ' + candidateScore);
  
          for (let t = 0; t < this._nbTopCandidates; t++) {
            const aTopCandidate = topCandidates[t];
  
            if (
              !aTopCandidate ||
              candidateScore > aTopCandidate.readability.contentScore
            ) {
              topCandidates.splice(t, 0, candidate);
              if (topCandidates.length > this._nbTopCandidates) {
                topCandidates.pop();
              }
              break;
            }
          }
        }
  
        let topCandidate = topCandidates[0] || null;
        let neededToCreateTopCandidate = false;
        var parentOfTopCandidate;
  
        // If we still have no top candidate, just use the body as a last resort.
        // We also have to copy the body node so it is something we can modify.
        if (topCandidate === null || topCandidate.tagName === 'BODY') {
          // Move all of the page's children into topCandidate
          topCandidate = doc.createElement('DIV');
          neededToCreateTopCandidate = true;
          // Move everything (not just elements, also text nodes etc.) into the container
          // so we even include text directly in the body:
          const kids = page.childNodes;
          while (kids.length) {
            this.log('Moving child out:', kids[0]);
            topCandidate.appendChild(kids[0]);
          }
  
          page.appendChild(topCandidate);
  
          this._initializeNode(topCandidate);
        } else if (topCandidate) {
          // Find a better top candidate node if it contains (at least three) nodes which belong to `topCandidates` array
          // and whose scores are quite closed with current `topCandidate` node.
          const alternativeCandidateAncestors = [];
          for (let i = 1; i < topCandidates.length; i++) {
            if (
              topCandidates[i].readability.contentScore /
              topCandidate.readability.contentScore >=
              0.75
            ) {
              alternativeCandidateAncestors.push(
                this._getNodeAncestors(topCandidates[i]),
              );
            }
          }
          const MINIMUM_TOPCANDIDATES = 3;
          if (alternativeCandidateAncestors.length >= MINIMUM_TOPCANDIDATES) {
            parentOfTopCandidate = topCandidate.parentNode;
            while (parentOfTopCandidate.tagName !== 'BODY') {
              let listsContainingThisAncestor = 0;
              for (
                let ancestorIndex = 0;
                ancestorIndex < alternativeCandidateAncestors.length &&
                listsContainingThisAncestor < MINIMUM_TOPCANDIDATES;
                ancestorIndex++
              ) {
                listsContainingThisAncestor += Number(
                  alternativeCandidateAncestors[ancestorIndex].includes(
                    parentOfTopCandidate,
                  ),
                );
              }
              if (listsContainingThisAncestor >= MINIMUM_TOPCANDIDATES) {
                topCandidate = parentOfTopCandidate;
                break;
              }
              parentOfTopCandidate = parentOfTopCandidate.parentNode;
            }
          }
          if (!topCandidate.readability) {
            this._initializeNode(topCandidate);
          }
  
          // Because of our bonus system, parents of candidates might have scores
          // themselves. They get half of the node. There won't be nodes with higher
          // scores than our topCandidate, but if we see the score going *up* in the first
          // few steps up the tree, that's a decent sign that there might be more content
          // lurking in other places that we want to unify in. The sibling stuff
          // below does some of that - but only if we've looked high enough up the DOM
          // tree.
          parentOfTopCandidate = topCandidate.parentNode;
          let lastScore = topCandidate.readability.contentScore;
          // The scores shouldn't get too low.
          const scoreThreshold = lastScore / 3;
          while (parentOfTopCandidate.tagName !== 'BODY') {
            if (!parentOfTopCandidate.readability) {
              parentOfTopCandidate = parentOfTopCandidate.parentNode;
              continue;
            }
            const parentScore = parentOfTopCandidate.readability.contentScore;
            if (parentScore < scoreThreshold) {
              break;
            }
            if (parentScore > lastScore) {
              // Alright! We found a better parent to use.
              topCandidate = parentOfTopCandidate;
              break;
            }
            lastScore = parentOfTopCandidate.readability.contentScore;
            parentOfTopCandidate = parentOfTopCandidate.parentNode;
          }
  
          // If the top candidate is the only child, use parent instead. This will help sibling
          // joining logic when adjacent content is actually located in parent's sibling node.
          parentOfTopCandidate = topCandidate.parentNode;
          while (
            parentOfTopCandidate.tagName != 'BODY' &&
            parentOfTopCandidate.children.length == 1
            ) {
            topCandidate = parentOfTopCandidate;
            parentOfTopCandidate = topCandidate.parentNode;
          }
          if (!topCandidate.readability) {
            this._initializeNode(topCandidate);
          }
        }
  
        // Now that we have the top candidate, look through its siblings for content
        // that might also be related. Things like preambles, content split by ads
        // that we removed, etc.
        let articleContent = doc.createElement('DIV');
        if (isPaging) {
          articleContent.id = 'readability-content';
        }
  
        const siblingScoreThreshold = Math.max(
          10,
          topCandidate.readability.contentScore * 0.2,
        );
        // Keep potential top candidate's parent node to try to get text direction of it later.
        parentOfTopCandidate = topCandidate.parentNode;
        const siblings = parentOfTopCandidate.children;
  
        for (let s = 0, sl = siblings.length; s < sl; s++) {
          let sibling = siblings[s];
          let append = false;
  
          this.log(
            'Looking at sibling node:',
            sibling,
            sibling.readability
              ? 'with score ' + sibling.readability.contentScore
              : '',
          );
          this.log(
            'Sibling has score',
            sibling.readability ? sibling.readability.contentScore : 'Unknown',
          );
  
          if (sibling === topCandidate) {
            append = true;
          } else {
            let contentBonus = 0;
  
            // Give a bonus if sibling nodes and top candidates have the example same classname
            if (
              sibling.className === topCandidate.className &&
              topCandidate.className !== ''
            ) {
              contentBonus += topCandidate.readability.contentScore * 0.2;
            }
  
            if (
              sibling.readability &&
              sibling.readability.contentScore + contentBonus >=
              siblingScoreThreshold
            ) {
              append = true;
            } else if (sibling.nodeName === 'P') {
              const linkDensity = this._getLinkDensity(sibling);
              const nodeContent = this._getInnerText(sibling);
              const nodeLength = nodeContent.length;
  
              if (nodeLength > 80 && linkDensity < 0.25) {
                append = true;
              } else if (
                nodeLength < 80 &&
                nodeLength > 0 &&
                linkDensity === 0 &&
                nodeContent.search(/\.( |$)/) !== -1
              ) {
                append = true;
              }
            }
          }
  
          if (append) {
            this.log('Appending node:', sibling);
  
            if (this.ALTER_TO_DIV_EXCEPTIONS.indexOf(sibling.nodeName) === -1) {
              // We have a node that isn't a common block level element, like a form or td tag.
              // Turn it into a div so it doesn't get filtered out later by accident.
              this.log('Altering sibling:', sibling, 'to div.');
  
              sibling = this._setNodeTag(sibling, 'DIV');
            }
  
            articleContent.appendChild(sibling);
            // siblings is a reference to the children array, and
            // sibling is removed from the array when we call appendChild().
            // As a result, we must revisit this index since the nodes
            // have been shifted.
            s -= 1;
            sl -= 1;
          }
        }
  
        if (this._debug) {
          this.log('Article content pre-prep: ' + articleContent.innerHTML);
        }
        // So we have all of the content that we need. Now we clean it up for presentation.
        this._prepArticle(articleContent);
        if (this._debug) {
          this.log('Article content post-prep: ' + articleContent.innerHTML);
        }
  
        if (neededToCreateTopCandidate) {
          // We already created a fake div thing, and there wouldn't have been any siblings left
          // for the previous loop, so there's no point trying to create a new div, and then
          // move all the children over. Just assign IDs and class names here. No need to append
          // because that already happened anyway.
          topCandidate.id = 'readability-page-1';
          topCandidate.className = 'page';
        } else {
          const div = doc.createElement('DIV');
          div.id = 'readability-page-1';
          div.className = 'page';
          const children = articleContent.childNodes;
          while (children.length) {
            div.appendChild(children[0]);
          }
          articleContent.appendChild(div);
        }
  
        if (this._debug) {
          this.log('Article content after paging: ' + articleContent.innerHTML);
        }
  
        let parseSuccessful = true;
  
        // Now that we've gone through the full algorithm, check to see if
        // we got any meaningful content. If we didn't, we may need to re-run
        // grabArticle with different flags set. This gives us a higher likelihood of
        // finding the content, and the sieve approach gives us a higher likelihood of
        // finding the -right- content.
        const textLength = this._getInnerText(articleContent, true).length;
        if (textLength < this._charThreshold) {
          parseSuccessful = false;
          page.innerHTML = pageCacheHtml;
  
          if (this._flagIsActive(this.FLAG_STRIP_UNLIKELYS)) {
            this._removeFlag(this.FLAG_STRIP_UNLIKELYS);
            this._attempts.push({articleContent, textLength});
          } else if (this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
            this._removeFlag(this.FLAG_WEIGHT_CLASSES);
            this._attempts.push({articleContent, textLength});
          } else if (this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
            this._removeFlag(this.FLAG_CLEAN_CONDITIONALLY);
            this._attempts.push({articleContent, textLength});
          } else {
            this._attempts.push({articleContent, textLength});
            // No luck after removing flags, just return the longest text we found during the different loops
            this._attempts.sort((a, b) => b.textLength - a.textLength);
  
            // But first check if we actually have something
            if (!this._attempts[0].textLength) {
              return null;
            }
  
            articleContent = this._attempts[0].articleContent;
            parseSuccessful = true;
          }
        }
  
        if (parseSuccessful) {
          // Find out text direction from ancestors of final top candidate.
          const ancestors = [parentOfTopCandidate, topCandidate].concat(
            this._getNodeAncestors(parentOfTopCandidate),
          );
          this._someNode(ancestors, function (ancestor) {
            if (!ancestor.tagName) {
              return false;
            }
            const articleDir = ancestor.getAttribute('dir');
            if (articleDir) {
              this._articleDir = articleDir;
              return true;
            }
            return false;
          });
          return articleContent;
        }
      }
    },
  
    /**
     * Check whether the input string could be a byline.
     * This verifies that the input is a string, and that the length
     * is less than 100 chars.
     *
     * @param possibleByline {string} - a string to check whether its a byline.
     * @return Boolean - whether the input string is a byline.
     */
    _isValidByline(byline) {
      if (typeof byline === 'string' || byline instanceof String) {
        byline = byline.trim();
        return byline.length > 0 && byline.length < 100;
      }
      return false;
    },
  
    /**
     * Converts some of the common HTML entities in string to their corresponding characters.
     *
     * @param str {string} - a string to unescape.
     * @return string without HTML entity.
     */
    _unescapeHtmlEntities(str) {
      if (!str) {
        return str;
      }
  
      const htmlEscapeMap = this.HTML_ESCAPE_MAP;
      return str
        .replace(/&(quot|amp|apos|lt|gt);/g, (_, tag) => htmlEscapeMap[tag])
        .replace(/&#(?:x([0-9a-z]{1,4})|([0-9]{1,4}));/gi, (_, hex, numStr) => {
          const num = parseInt(hex || numStr, hex ? 16 : 10);
          return String.fromCharCode(num);
        });
    },
  
    /**
     * Attempts to get excerpt and byline metadata for the article.
     *
     * @return Object with optional "excerpt" and "byline" properties
     */
    _getArticleMetadata() {
      const metadata = {};
      const values = {};
      const metaElements = this._doc.getElementsByTagName('meta');
  
      // property is a space-separated list of values
      const propertyPattern =
        /\s*(dc|dcterm|og|twitter)\s*:\s*(author|creator|description|title|site_name)\s*/gi;
  
      // name is a single value
      const namePattern =
        /^\s*(?:(dc|dcterm|og|twitter|weibo:(article|webpage))\s*[\.:]\s*)?(author|creator|description|title|site_name)\s*$/i;
  
      // Find description tags.
      this._forEachNode(metaElements, (element) => {
        const elementName = element.getAttribute('name');
        const elementProperty = element.getAttribute('property');
        const content = element.getAttribute('content');
        if (!content) {
          return;
        }
        let matches = null;
        let name = null;
  
        if (elementProperty) {
          matches = elementProperty.match(propertyPattern);
          if (matches) {
            for (let i = matches.length - 1; i >= 0; i--) {
              // Convert to lowercase, and remove any whitespace
              // so we can match below.
              name = matches[i].toLowerCase().replace(/\s/g, '');
              // multiple authors
              values[name] = content.trim();
            }
          }
        }
        if (!matches && elementName && namePattern.test(elementName)) {
          name = elementName;
          if (content) {
            // Convert to lowercase, remove any whitespace, and convert dots
            // to colons so we can match below.
            name = name.toLowerCase().replace(/\s/g, '').replace(/\./g, ':');
            values[name] = content.trim();
          }
        }
      });
  
      // get title
      metadata.title =
        values['dc:title'] ||
        values['dcterm:title'] ||
        values['og:title'] ||
        values['weibo:article:title'] ||
        values['weibo:webpage:title'] ||
        values.title ||
        values['twitter:title'];
  
      if (!metadata.title) {
        metadata.title = this._getArticleTitle();
      }
  
      // get author
      metadata.byline =
        values['dc:creator'] || values['dcterm:creator'] || values.author;
  
      // get description
      metadata.excerpt =
        values['dc:description'] ||
        values['dcterm:description'] ||
        values['og:description'] ||
        values['weibo:article:description'] ||
        values['weibo:webpage:description'] ||
        values.description ||
        values['twitter:description'];
  
      // get site name
      metadata.siteName = values['og:site_name'];
  
      // in many sites the meta value is escaped with HTML entities,
      // so here we need to unescape it
      metadata.title = this._unescapeHtmlEntities(metadata.title);
      metadata.byline = this._unescapeHtmlEntities(metadata.byline);
      metadata.excerpt = this._unescapeHtmlEntities(metadata.excerpt);
      metadata.siteName = this._unescapeHtmlEntities(metadata.siteName);
  
      return metadata;
    },
  
    /**
     * Check if node is image, or if node contains exactly only one image
     * whether as a direct child or as its descendants.
     *
     * @param Element
     **/
    _isSingleImage(node) {
      if (node.tagName === 'IMG') {
        return true;
      }
  
      if (node.children.length !== 1 || node.textContent.trim() !== '') {
        return false;
      }
  
      return this._isSingleImage(node.children[0]);
    },
  
    /**
     * Find all <noscript> that are located after <img> nodes, and which contain only one
     * <img> element. Replace the first image with the image from inside the <noscript> tag,
     * and remove the <noscript> tag. This improves the quality of the images we use on
     * some sites (e.g. Medium).
     *
     * @param Element
     **/
    _unwrapNoscriptImages(doc) {
      // Find img without source or attributes that might contains image, and remove it.
      // This is done to prevent a placeholder img is replaced by img from noscript in next step.
      const imgs = Array.from(doc.getElementsByTagName('img'));
      this._forEachNode(imgs, (img) => {
        for (let i = 0; i < img.attributes.length; i++) {
          const attr = img.attributes[i];
          switch (attr.name) {
            case 'src':
            case 'srcset':
            case 'data-src':
            case 'data-srcset':
              return;
          }
  
          if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
            return;
          }
        }
  
        img.parentNode.removeChild(img);
      });
  
      // Next find noscript and try to extract its image
      const noscripts = Array.from(doc.getElementsByTagName('noscript'));
      this._forEachNode(noscripts, function (noscript) {
        // Parse content of noscript and make sure it only contains image
        const tmp = doc.createElement('div');
        tmp.innerHTML = noscript.innerHTML;
        if (!this._isSingleImage(tmp)) {
          return;
        }
  
        // If noscript has previous sibling and it only contains image,
        // replace it with noscript content. However we also keep old
        // attributes that might contains image.
        const prevElement = noscript.previousElementSibling;
        if (prevElement && this._isSingleImage(prevElement)) {
          let prevImg = prevElement;
          if (prevImg.tagName !== 'IMG') {
            prevImg = prevElement.getElementsByTagName('img')[0];
          }
  
          const newImg = tmp.getElementsByTagName('img')[0];
          for (let i = 0; i < prevImg.attributes.length; i++) {
            const attr = prevImg.attributes[i];
            if (attr.value === '') {
              continue;
            }
  
            if (
              attr.name === 'src' ||
              attr.name === 'srcset' ||
              /\.(jpg|jpeg|png|webp)/i.test(attr.value)
            ) {
              if (newImg.getAttribute(attr.name) === attr.value) {
                continue;
              }
  
              let attrName = attr.name;
              if (newImg.hasAttribute(attrName)) {
                attrName = 'data-old-' + attrName;
              }
  
              newImg.setAttribute(attrName, attr.value);
            }
          }
  
          noscript.parentNode.replaceChild(tmp.firstElementChild, prevElement);
        }
      });
    },
  
    /**
     * Removes script tags from the document.
     *
     * @param Element
     **/
    _removeScripts(doc) {
      this._removeNodes(
        this._getAllNodesWithTag(doc, ['script']),
        (scriptNode) => {
          scriptNode.nodeValue = '';
          scriptNode.removeAttribute('src');
          return true;
        },
      );
      this._removeNodes(this._getAllNodesWithTag(doc, ['noscript']));
    },
  
    /**
     * Check if this node has only whitespace and a single element with given tag
     * Returns false if the DIV node contains non-empty text nodes
     * or if it contains no element with given tag or more than 1 element.
     *
     * @param Element
     * @param string tag of child element
     **/
    _hasSingleTagInsideElement(element, tag) {
      // There should be exactly 1 element child with given tag
      if (element.children.length != 1 || element.children[0].tagName !== tag) {
        return false;
      }
  
      // And there should be no text nodes with real content
      return !this._someNode(element.childNodes, function (node) {
        return (
          node.nodeType === this.TEXT_NODE &&
          this.REGEXPS.hasContent.test(node.textContent)
        );
      });
    },
  
    _isElementWithoutContent(node) {
      return (
        node.nodeType === this.ELEMENT_NODE &&
        node.textContent.trim().length == 0 &&
        (node.children.length == 0 ||
          node.children.length ==
          node.getElementsByTagName('br').length +
          node.getElementsByTagName('hr').length)
      );
    },
  
    /**
     * Determine whether element has any children block level elements.
     *
     * @param Element
     */
    _hasChildBlockElement(element) {
      return this._someNode(element.childNodes, function (node) {
        return (
          this.DIV_TO_P_ELEMS.indexOf(node.tagName) !== -1 ||
          this._hasChildBlockElement(node)
        );
      });
    },
  
    /** *
     * Determine if a node qualifies as phrasing content.
     * https://developer.mozilla.org/en-US/docs/Web/Guide/HTML/Content_categories#Phrasing_content
     **/
    _isPhrasingContent(node) {
      return (
        node.nodeType === this.TEXT_NODE ||
        this.PHRASING_ELEMS.indexOf(node.tagName) !== -1 ||
        ((node.tagName === 'A' ||
            node.tagName === 'DEL' ||
            node.tagName === 'INS') &&
          this._everyNode(node.childNodes, this._isPhrasingContent))
      );
    },
  
    _isWhitespace(node) {
      return (
        (node.nodeType === this.TEXT_NODE &&
          node.textContent.trim().length === 0) ||
        (node.nodeType === this.ELEMENT_NODE && node.tagName === 'BR')
      );
    },
  
    /**
     * Get the inner text of a node - cross browser compatibly.
     * This also strips out any excess whitespace to be found.
     *
     * @param Element
     * @param Boolean normalizeSpaces (default: true)
     * @return string
     **/
    _getInnerText(e, normalizeSpaces) {
      normalizeSpaces =
        typeof normalizeSpaces === 'undefined' ? true : normalizeSpaces;
      const textContent = e.textContent.trim();
  
      if (normalizeSpaces) {
        return textContent.replace(this.REGEXPS.normalize, ' ');
      }
      return textContent;
    },
  
    /**
     * Get the number of times a string s appears in the node e.
     *
     * @param Element
     * @param string - what to split on. Default is ","
     * @return number (integer)
     **/
    _getCharCount(e, s) {
      s = s || ',';
      return this._getInnerText(e).split(s).length - 1;
    },
  
    /**
     * Remove the style attribute on every e and under.
     * TODO: Test if getElementsByTagName(*) is faster.
     *
     * @param Element
     * @return void
     **/
    _cleanStyles(e) {
      if (!e || e.tagName.toLowerCase() === 'svg') {
        return;
      }
  
      // Remove `style` and deprecated presentational attributes
      for (let i = 0; i < this.PRESENTATIONAL_ATTRIBUTES.length; i++) {
        e.removeAttribute(this.PRESENTATIONAL_ATTRIBUTES[i]);
      }
  
      if (this.DEPRECATED_SIZE_ATTRIBUTE_ELEMS.indexOf(e.tagName) !== -1) {
        e.removeAttribute('width');
        e.removeAttribute('height');
      }
  
      let cur = e.firstElementChild;
      while (cur !== null) {
        this._cleanStyles(cur);
        cur = cur.nextElementSibling;
      }
    },
  
    /**
     * Get the density of links as a percentage of the content
     * This is the amount of text that is inside a link divided by the total text in the node.
     *
     * @param Element
     * @return number (float)
     **/
    _getLinkDensity(element) {
      const textLength = this._getInnerText(element).length;
      if (textLength === 0) {
        return 0;
      }
  
      let linkLength = 0;
  
      // XXX implement _reduceNodeList?
      this._forEachNode(element.getElementsByTagName('a'), function (linkNode) {
        linkLength += this._getInnerText(linkNode).length;
      });
  
      return linkLength / textLength;
    },
  
    /**
     * Get an elements class/id weight. Uses regular expressions to tell if this
     * element looks good or bad.
     *
     * @param Element
     * @return number (Integer)
     **/
    _getClassWeight(e) {
      if (!this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
        return 0;
      }
  
      let weight = 0;
  
      // Look for a special classname
      if (typeof e.className === 'string' && e.className !== '') {
        if (this.REGEXPS.negative.test(e.className)) {
          weight -= 25;
        }
  
        if (this.REGEXPS.positive.test(e.className)) {
          weight += 25;
        }
      }
  
      // Look for a special ID
      if (typeof e.id === 'string' && e.id !== '') {
        if (this.REGEXPS.negative.test(e.id)) {
          weight -= 25;
        }
  
        if (this.REGEXPS.positive.test(e.id)) {
          weight += 25;
        }
      }
  
      return weight;
    },
  
    /**
     * Clean a node of all elements of type "tag".
     * (Unless it's a youtube/vimeo video. People love movies.)
     *
     * @param Element
     * @param string tag to clean
     * @return void
     **/
    _clean(e, tag) {
      const isEmbed = ['object', 'embed', 'iframe'].indexOf(tag) !== -1;
  
      this._removeNodes(this._getAllNodesWithTag(e, [tag]), function (element) {
        // Allow youtube and vimeo videos through as people usually want to see those.
        if (isEmbed) {
          // First, check the elements attributes to see if any of them contain youtube or vimeo
          for (let i = 0; i < element.attributes.length; i++) {
            if (this.REGEXPS.videos.test(element.attributes[i].value)) {
              return false;
            }
          }
  
          // For embed with <object> tag, check inner HTML as well.
          if (
            element.tagName === 'object' &&
            this.REGEXPS.videos.test(element.innerHTML)
          ) {
            return false;
          }
        }
  
        return true;
      });
    },
  
    /**
     * Check if a given node has one of its ancestor tag name matching the
     * provided one.
     * @param  HTMLElement node
     * @param  String      tagName
     * @param  Number      maxDepth
     * @param  Function    filterFn a filter to invoke to determine whether this node 'counts'
     * @return Boolean
     */
    _hasAncestorTag(node, tagName, maxDepth, filterFn) {
      maxDepth = maxDepth || 3;
      tagName = tagName.toUpperCase();
      let depth = 0;
      while (node.parentNode) {
        if (maxDepth > 0 && depth > maxDepth) {
          return false;
        }
        if (
          node.parentNode.tagName === tagName &&
          (!filterFn || filterFn(node.parentNode))
        ) {
          return true;
        }
        node = node.parentNode;
        depth++;
      }
      return false;
    },
  
    /**
     * Return an object indicating how many rows and columns this table has.
     */
    _getRowAndColumnCount(table) {
      let rows = 0;
      let columns = 0;
      const trs = table.getElementsByTagName('tr');
      for (let i = 0; i < trs.length; i++) {
        let rowspan = trs[i].getAttribute('rowspan') || 0;
        if (rowspan) {
          rowspan = parseInt(rowspan, 10);
        }
        rows += rowspan || 1;
  
        // Now look for column-related info
        let columnsInThisRow = 0;
        const cells = trs[i].getElementsByTagName('td');
        for (let j = 0; j < cells.length; j++) {
          let colspan = cells[j].getAttribute('colspan') || 0;
          if (colspan) {
            colspan = parseInt(colspan, 10);
          }
          columnsInThisRow += colspan || 1;
        }
        columns = Math.max(columns, columnsInThisRow);
      }
      return {rows, columns};
    },
  
    /**
     * Look for 'data' (as opposed to 'layout') tables, for which we use
     * similar checks as
     * https://dxr.mozilla.org/mozilla-central/rev/71224049c0b52ab190564d3ea0eab089a159a4cf/accessible/html/HTMLTableAccessible.cpp#920
     */
    _markDataTables(root) {
      const tables = root.getElementsByTagName('table');
      for (let i = 0; i < tables.length; i++) {
        var table = tables[i];
        const role = table.getAttribute('role');
        if (role == 'presentation') {
          table._readabilityDataTable = false;
          continue;
        }
        const datatable = table.getAttribute('datatable');
        if (datatable == '0') {
          table._readabilityDataTable = false;
          continue;
        }
        const summary = table.getAttribute('summary');
        if (summary) {
          table._readabilityDataTable = true;
          continue;
        }
  
        const caption = table.getElementsByTagName('caption')[0];
        if (caption && caption.childNodes.length > 0) {
          table._readabilityDataTable = true;
          continue;
        }
  
        // If the table has a descendant with any of these tags, consider a data table:
        const dataTableDescendants = ['col', 'colgroup', 'tfoot', 'thead', 'th'];
        const descendantExists = function (tag) {
          return !!table.getElementsByTagName(tag)[0];
        };
        if (dataTableDescendants.some(descendantExists)) {
          this.log('Data table because found data-y descendant');
          table._readabilityDataTable = true;
          continue;
        }
  
        // Nested tables indicate a layout table:
        if (table.getElementsByTagName('table')[0]) {
          table._readabilityDataTable = false;
          continue;
        }
  
        const sizeInfo = this._getRowAndColumnCount(table);
        if (sizeInfo.rows >= 10 || sizeInfo.columns > 4) {
          table._readabilityDataTable = true;
          continue;
        }
        // Now just go by size entirely:
        table._readabilityDataTable = sizeInfo.rows * sizeInfo.columns > 10;
      }
    },
  
    /* convert images and figures that have properties like data-src into images that can be loaded without JS */
    _fixLazyImages(root) {
      this._forEachNode(
        this._getAllNodesWithTag(root, ['img', 'picture', 'figure']),
        function (elem) {
          // In some sites (e.g. Kotaku), they put 1px square image as base64 data uri in the src attribute.
          // So, here we check if the data uri is too short, just might as well remove it.
          if (elem.src && this.REGEXPS.b64DataUrl.test(elem.src)) {
            // Make sure it's not SVG, because SVG can have a meaningful image in under 133 bytes.
            const parts = this.REGEXPS.b64DataUrl.exec(elem.src);
            if (parts[1] === 'image/svg+xml') {
              return;
            }
  
            // Make sure this element has other attributes which contains image.
            // If it doesn't, then this src is important and shouldn't be removed.
            let srcCouldBeRemoved = false;
            for (let i = 0; i < elem.attributes.length; i++) {
              var attr = elem.attributes[i];
              if (attr.name === 'src') {
                continue;
              }
  
              if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
                srcCouldBeRemoved = true;
                break;
              }
            }
  
            // Here we assume if image is less than 100 bytes (or 133B after encoded to base64)
            // it will be too small, therefore it might be placeholder image.
            if (srcCouldBeRemoved) {
              const b64starts = elem.src.search(/base64\s*/i) + 7;
              const b64length = elem.src.length - b64starts;
              if (b64length < 133) {
                elem.removeAttribute('src');
              }
            }
          }
  
          // also check for "null" to work around https://github.com/jsdom/jsdom/issues/2580
          if (
            (elem.src || (elem.srcset && elem.srcset != 'null')) &&
            elem.className.toLowerCase().indexOf('lazy') === -1
          ) {
            return;
          }
  
          for (let j = 0; j < elem.attributes.length; j++) {
            attr = elem.attributes[j];
            if (attr.name === 'src' || attr.name === 'srcset') {
              continue;
            }
            let copyTo = null;
            if (/\.(jpg|jpeg|png|webp)\s+\d/.test(attr.value)) {
              copyTo = 'srcset';
            } else if (/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/.test(attr.value)) {
              copyTo = 'src';
            }
            if (copyTo) {
              // if this is an img or picture, set the attribute directly
              if (elem.tagName === 'IMG' || elem.tagName === 'PICTURE') {
                elem.setAttribute(copyTo, attr.value);
              } else if (
                elem.tagName === 'FIGURE' &&
                !this._getAllNodesWithTag(elem, ['img', 'picture']).length
              ) {
                // if the item is a <figure> that does not contain an image or picture, create one and place it inside the figure
                // see the nytimes-3 testcase for an example
                const img = this._doc.createElement('img');
                img.setAttribute(copyTo, attr.value);
                elem.appendChild(img);
              }
            }
          }
        },
      );
    },
  
    /**
     * Clean an element of all tags of type "tag" if they look fishy.
     * "Fishy" is an algorithm based on content length, classnames, link density, number of images & embeds, etc.
     *
     * @return void
     **/
    _cleanConditionally(e, tag) {
      if (!this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
        return;
      }
  
      const isList = tag === 'ul' || tag === 'ol';
  
      // Gather counts for other typical elements embedded within.
      // Traverse backwards so we can remove nodes at the same time
      // without effecting the traversal.
      //
      // TODO: Consider taking into account original contentScore here.
      this._removeNodes(this._getAllNodesWithTag(e, [tag]), function (node) {
        // First check if this node IS data table, in which case don't remove it.
        const isDataTable = function (t) {
          return t._readabilityDataTable;
        };
  
        if (tag === 'table' && isDataTable(node)) {
          return false;
        }
  
        // Next check if we're inside a data table, in which case don't remove it as well.
        if (this._hasAncestorTag(node, 'table', -1, isDataTable)) {
          return false;
        }
  
        const weight = this._getClassWeight(node);
        const contentScore = 0;
  
        this.log('Cleaning Conditionally', node);
  
        if (weight + contentScore < 0) {
          return true;
        }
  
        if (this._getCharCount(node, ',') < 10) {
          // If there are not very many commas, and the number of
          // non-paragraph elements is more than paragraphs or other
          // ominous signs, remove the element.
          const p = node.getElementsByTagName('p').length;
          const img = node.getElementsByTagName('img').length;
          const li = node.getElementsByTagName('li').length - 100;
          const input = node.getElementsByTagName('input').length;
  
          let embedCount = 0;
          const embeds = this._getAllNodesWithTag(node, [
            'object',
            'embed',
            'iframe',
          ]);
  
          for (let i = 0; i < embeds.length; i++) {
            // If this embed has attribute that matches video regex, don't delete it.
            for (let j = 0; j < embeds[i].attributes.length; j++) {
              if (this.REGEXPS.videos.test(embeds[i].attributes[j].value)) {
                return false;
              }
            }
  
            // For embed with <object> tag, check inner HTML as well.
            if (
              embeds[i].tagName === 'object' &&
              this.REGEXPS.videos.test(embeds[i].innerHTML)
            ) {
              return false;
            }
  
            embedCount++;
          }
  
          const linkDensity = this._getLinkDensity(node);
          const contentLength = this._getInnerText(node).length;
  
          const haveToRemove =
            (img > 1 && p / img < 0.5 && !this._hasAncestorTag(node, 'figure')) ||
            (!isList && li > p) ||
            input > Math.floor(p / 3) ||
            (!isList &&
              contentLength < 25 &&
              (img === 0 || img > 2) &&
              !this._hasAncestorTag(node, 'figure')) ||
            (!isList && weight < 25 && linkDensity > 0.2) ||
            (weight >= 25 && linkDensity > 0.5) ||
            (embedCount === 1 && contentLength < 75) ||
            embedCount > 1;
          return haveToRemove;
        }
        return false;
      });
    },
  
    /**
     * Clean out elements that match the specified conditions
     *
     * @param Element
     * @param Function determines whether a node should be removed
     * @return void
     **/
    _cleanMatchedNodes(e, filter) {
      const endOfSearchMarkerNode = this._getNextNode(e, true);
      let next = this._getNextNode(e);
      while (next && next != endOfSearchMarkerNode) {
        if (filter.call(this, next, next.className + ' ' + next.id)) {
          next = this._removeAndGetNext(next);
        } else {
          next = this._getNextNode(next);
        }
      }
    },
  
    /**
     * Clean out spurious headers from an Element. Checks things like classnames and link density.
     *
     * @param Element
     * @return void
     **/
    _cleanHeaders(e) {
      this._removeNodes(
        this._getAllNodesWithTag(e, ['h1', 'h2']),
        function (header) {
          return this._getClassWeight(header) < 0;
        },
      );
    },
  
    _flagIsActive(flag) {
      return (this._flags & flag) > 0;
    },
  
    _removeFlag(flag) {
      this._flags = this._flags & ~flag;
    },
  
    _isProbablyVisible(node) {
      // Have to null-check node.style and node.className.indexOf to deal with SVG and MathML nodes.
      return (
        (!node.style || node.style.display != 'none') &&
        !node.hasAttribute('hidden') &&
        // check for "fallback-image" so that wikimedia math images are displayed
        (!node.hasAttribute('aria-hidden') ||
          node.getAttribute('aria-hidden') != 'true' ||
          (node.className &&
            node.className.indexOf &&
            node.className.indexOf('fallback-image') !== -1))
      );
    },
  
    /**
     * Runs readability.
     *
     * Workflow:
     *  1. Prep the document by removing script tags, css, etc.
     *  2. Build readability's DOM tree.
     *  3. Grab the article content from the current dom tree.
     *  4. Replace the current DOM tree with the new one.
     *  5. Read peacefully.
     *
     * @return void
     **/
    parse() {
      // Avoid parsing too large documents, as per configuration option
      if (this._maxElemsToParse > 0) {
        const numTags = this._doc.getElementsByTagName('*').length;
        if (numTags > this._maxElemsToParse) {
          throw new Error(
            'Aborting parsing document; ' + numTags + ' elements found',
          );
        }
      }
  
      // Unwrap image from noscript
      this._unwrapNoscriptImages(this._doc);
  
      // Remove script tags from the document.
      this._removeScripts(this._doc);
  
      this._prepDocument();
  
      const metadata = this._getArticleMetadata();
      this._articleTitle = metadata.title;
  
      const articleContent = this._grabArticle();
      if (!articleContent) {
        return null;
      }
  
      this.log('Grabbed: ' + articleContent.innerHTML);
  
      this._postProcessContent(articleContent);
  
      // If we haven't found an excerpt in the article's metadata, use the article's
      // first paragraph as the excerpt. This is used for displaying a preview of
      // the article's content.
      if (!metadata.excerpt) {
        const paragraphs = articleContent.getElementsByTagName('p');
        if (paragraphs.length > 0) {
          metadata.excerpt = paragraphs[0].textContent.trim();
        }
      }
  
      const textContent = articleContent.textContent;
      return {
        title: this._articleTitle,
        byline: metadata.byline || this._articleByline,
        dir: this._articleDir,
        content: articleContent.innerHTML,
        textContent,
        length: textContent.length,
        excerpt: metadata.excerpt,
        siteName: metadata.siteName || this._articleSiteName,
      };
    },
  };
      return Readability;
    })();
  
    const TurndownService = (function() {
      // ... [Turndown code from your gist, with modifications] ...
      function extend(destination) {
        for (let i = 1; i < arguments.length; i++) {
          const source = arguments[i];
          for (const key in source) {
            if (source.hasOwnProperty(key)) destination[key] = source[key];
          }
        }
        return destination;
      }
      
      function repeat(character, count) {
        return Array(count + 1).join(character);
      }
      
      const blockElements = [
        'address',
        'article',
        'aside',
        'audio',
        'blockquote',
        'body',
        'canvas',
        'center',
        'dd',
        'dir',
        'div',
        'dl',
        'dt',
        'fieldset',
        'figcaption',
        'figure',
        'footer',
        'form',
        'frameset',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'header',
        'hgroup',
        'hr',
        'html',
        'isindex',
        'li',
        'main',
        'menu',
        'nav',
        'noframes',
        'noscript',
        'ol',
        'output',
        'p',
        'pre',
        'section',
        'table',
        'tbody',
        'td',
        'tfoot',
        'th',
        'thead',
        'tr',
        'ul',
      ];
      
      function isBlock(node) {
        return blockElements.indexOf(node.nodeName.toLowerCase()) !== -1;
      }
      
      const voidElements = [
        'area',
        'base',
        'br',
        'col',
        'command',
        'embed',
        'hr',
        'img',
        'input',
        'keygen',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
      ];
      
      function isVoid(node) {
        return voidElements.indexOf(node.nodeName.toLowerCase()) !== -1;
      }
      
      const voidSelector = voidElements.join();
      function hasVoid(node) {
        return node.querySelector && node.querySelector(voidSelector);
      }
      
      const rules = {};
      
      rules.paragraph = {
        filter: 'p',
      
        replacement: function (content) {
          return '\n\n' + content + '\n\n';
        },
      };
      
      rules.lineBreak = {
        filter: 'br',
      
        replacement: function (content, node, options) {
          return options.br + '\n';
        },
      };
      
      rules.heading = {
        filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      
        replacement: function (content, node, options) {
          const hLevel = Number(node.nodeName.charAt(1));
      
          if (options.headingStyle === 'setext' && hLevel < 3) {
            const underline = repeat(hLevel === 1 ? '=' : '-', content.length);
            return '\n\n' + content + '\n' + underline + '\n\n';
          } else {
            return '\n\n' + repeat('#', hLevel) + ' ' + content + '\n\n';
          }
        },
      };
      
      rules.blockquote = {
        filter: 'blockquote',
      
        replacement: function (content) {
          content = content.replace(/^\n+|\n+$/g, '');
          content = content.replace(/^/gm, '> ');
          return '\n\n' + content + '\n\n';
        },
      };
      
      rules.list = {
        filter: ['ul', 'ol'],
      
        replacement: function (content, node) {
          const parent = node.parentNode;
          if (parent.nodeName === 'LI' && parent.lastElementChild === node) {
            return '\n' + content;
          } else {
            return '\n\n' + content + '\n\n';
          }
        },
      };
      
      rules.listItem = {
        filter: 'li',
      
        replacement: function (content, node, options) {
          content = content
            .replace(/^\n+/, '') // remove leading newlines
            .replace(/\n+$/, '\n') // replace trailing newlines with just a single one
            .replace(/\n/gm, '\n    '); // indent
          let prefix = options.bulletListMarker + '   ';
          const parent = node.parentNode;
          if (parent.nodeName === 'OL') {
            const start = parent.getAttribute('start');
            const index = Array.prototype.indexOf.call(parent.children, node);
            prefix = (start ? Number(start) + index : index + 1) + '.  ';
          }
          return (
            prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
          );
        },
      };
      
      rules.indentedCodeBlock = {
        filter: function (node, options) {
          return (
            options.codeBlockStyle === 'indented' &&
            node.nodeName === 'PRE' &&
            node.firstChild &&
            node.firstChild.nodeName === 'CODE'
          );
        },
      
        replacement: function (content, node, options) {
          return (
            '\n\n    ' + node.firstChild.textContent.replace(/\n/g, '\n    ') + '\n\n'
          );
        },
      };
      
      rules.fencedCodeBlock = {
        filter: function (node, options) {
          return (
            options.codeBlockStyle === 'fenced' &&
            node.nodeName === 'PRE' &&
            node.firstChild &&
            node.firstChild.nodeName === 'CODE'
          );
        },
      
        replacement: function (content, node, options) {
          const className = node.firstChild.className || '';
          const language = (className.match(/language-(\S+)/) || [null, ''])[1];
          const code = node.firstChild.textContent;
      
          const fenceChar = options.fence.charAt(0);
          let fenceSize = 3;
          const fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');
      
          let match;
          while ((match = fenceInCodeRegex.exec(code))) {
            if (match[0].length >= fenceSize) {
              fenceSize = match[0].length + 1;
            }
          }
      
          const fence = repeat(fenceChar, fenceSize);
      
          return (
            '\n\n' +
            fence +
            language +
            '\n' +
            code.replace(/\n$/, '') +
            '\n' +
            fence +
            '\n\n'
          );
        },
      };
      
      rules.horizontalRule = {
        filter: 'hr',
      
        replacement: function (content, node, options) {
          return '\n\n' + options.hr + '\n\n';
        },
      };
      
      rules.inlineLink = {
        filter: function (node, options) {
          return (
            options.linkStyle === 'inlined' &&
            node.nodeName === 'A' &&
            node.getAttribute('href')
          );
        },
      
        replacement: function (content, node) {
          const href = node.getAttribute('href');
          const title = node.title ? ' "' + node.title + '"' : '';
          return '[' + content + '](' + href + title + ')';
        },
      };
      
      rules.referenceLink = {
        filter: function (node, options) {
          return (
            options.linkStyle === 'referenced' &&
            node.nodeName === 'A' &&
            node.getAttribute('href')
          );
        },
      
        replacement: function (content, node, options) {
          const href = node.getAttribute('href');
          const title = node.title ? ' "' + node.title + '"' : '';
          let replacement;
          let reference;
      
          switch (options.linkReferenceStyle) {
            case 'collapsed':
              replacement = '[' + content + '][]';
              reference = '[' + content + ']: ' + href + title;
              break;
            case 'shortcut':
              replacement = '[' + content + ']';
              reference = '[' + content + ']: ' + href + title;
              break;
            default:
              var id = this.references.length + 1;
              replacement = '[' + content + '][' + id + ']';
              reference = '[' + id + ']: ' + href + title;
          }
      
          this.references.push(reference);
          return replacement;
        },
      
        references: [],
      
        append: function (options) {
          let references = '';
          if (this.references.length) {
            references = '\n\n' + this.references.join('\n') + '\n\n';
            this.references = []; // Reset references
          }
          return references;
        },
      };
      
      rules.emphasis = {
        filter: ['em', 'i'],
      
        replacement: function (content, node, options) {
          if (!content.trim()) return '';
          return options.emDelimiter + content + options.emDelimiter;
        },
      };
      
      rules.strong = {
        filter: ['strong', 'b'],
      
        replacement: function (content, node, options) {
          if (!content.trim()) return '';
          return options.strongDelimiter + content + options.strongDelimiter;
        },
      };
      
      rules.code = {
        filter: function (node) {
          const hasSiblings = node.previousSibling || node.nextSibling;
          const isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;
      
          return node.nodeName === 'CODE' && !isCodeBlock;
        },
      
        replacement: function (content) {
          if (!content.trim()) return '';
      
          let delimiter = '`';
          let leadingSpace = '';
          let trailingSpace = '';
          const matches = content.match(/`+/gm);
          if (matches) {
            if (/^`/.test(content)) leadingSpace = ' ';
            if (/`$/.test(content)) trailingSpace = ' ';
            while (matches.indexOf(delimiter) !== -1) delimiter = delimiter + '`';
          }
      
          return delimiter + leadingSpace + content + trailingSpace + delimiter;
        },
      };
      
      rules.image = {
        filter: 'img',
      
        replacement: function (content, node) {
          const alt = node.alt || '';
          const src = node.getAttribute('src') || '';
          const title = node.title || '';
          const titlePart = title ? ' "' + title + '"' : '';
          return src ? '![' + alt + ']' + '(' + src + titlePart + ')' : '';
        },
      };
      
      /**
       * Manages a collection of rules used to convert HTML to Markdown
       */
      
      function Rules(options) {
        this.options = options;
        this._keep = [];
        this._remove = [];
      
        this.blankRule = {
          replacement: options.blankReplacement,
        };
      
        this.keepReplacement = options.keepReplacement;
      
        this.defaultRule = {
          replacement: options.defaultReplacement,
        };
      
        this.array = [];
        for (const key in options.rules) this.array.push(options.rules[key]);
      }
      
      Rules.prototype = {
        add: function (key, rule) {
          this.array.unshift(rule);
        },
      
        keep: function (filter) {
          this._keep.unshift({
            filter: filter,
            replacement: this.keepReplacement,
          });
        },
      
        remove: function (filter) {
          this._remove.unshift({
            filter: filter,
            replacement: function () {
              return '';
            },
          });
        },
      
        forNode: function (node) {
          if (node.isBlank) return this.blankRule;
          let rule;
      
          if ((rule = findRule(this.array, node, this.options))) return rule;
          if ((rule = findRule(this._keep, node, this.options))) return rule;
          if ((rule = findRule(this._remove, node, this.options))) return rule;
      
          return this.defaultRule;
        },
      
        forEach: function (fn) {
          for (let i = 0; i < this.array.length; i++) fn(this.array[i], i);
        },
      };
      
      function findRule(rules, node, options) {
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];
          if (filterValue(rule, node, options)) return rule;
        }
        return void 0;
      }
      
      function filterValue(rule, node, options) {
        const filter = rule.filter;
        if (typeof filter === 'string') {
          if (filter === node.nodeName.toLowerCase()) return true;
        } else if (Array.isArray(filter)) {
          if (filter.indexOf(node.nodeName.toLowerCase()) > -1) return true;
        } else if (typeof filter === 'function') {
          if (filter.call(rule, node, options)) return true;
        } else {
          throw new TypeError('`filter` needs to be a string, array, or function');
        }
      }
      
      /**
       * The collapseWhitespace function is adapted from collapse-whitespace
       * by Luc Thevenard.
       *
       * The MIT License (MIT)
       *
       * Copyright (c) 2014 Luc Thevenard <lucthevenard@gmail.com>
       *
       * Permission is hereby granted, free of charge, to any person obtaining a copy
       * of this software and associated documentation files (the "Software"), to deal
       * in the Software without restriction, including without limitation the rights
       * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
       * copies of the Software, and to permit persons to whom the Software is
       * furnished to do so, subject to the following conditions:
       *
       * The above copyright notice and this permission notice shall be included in
       * all copies or substantial portions of the Software.
       *
       * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
       * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
       * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
       * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
       * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
       * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
       * THE SOFTWARE.
       */
      
      /**
       * collapseWhitespace(options) removes extraneous whitespace from an the given element.
       *
       * @param {Object} options
       */
      function collapseWhitespace(options) {
        const element = options.element;
        const isBlock = options.isBlock;
        const isVoid = options.isVoid;
        const isPre =
          options.isPre ||
          function (node) {
            return node.nodeName === 'PRE';
          };
      
        if (!element.firstChild || isPre(element)) return;
      
        let prevText = null;
        let prevVoid = false;
      
        let prev = null;
        let node = next(prev, element, isPre);
      
        while (node !== element) {
          if (node.nodeType === 3 || node.nodeType === 4) {
            // Node.TEXT_NODE or Node.CDATA_SECTION_NODE
            let text = node.data.replace(/[ \r\n\t]+/g, ' ');
      
            if (
              (!prevText || / $/.test(prevText.data)) &&
              !prevVoid &&
              text[0] === ' '
            ) {
              text = text.substr(1);
            }
      
            // `text` might be empty at this point.
            if (!text) {
              node = remove(node);
              continue;
            }
      
            node.data = text;
      
            prevText = node;
          } else if (node.nodeType === 1) {
            // Node.ELEMENT_NODE
            if (isBlock(node) || node.nodeName === 'BR') {
              if (prevText) {
                prevText.data = prevText.data.replace(/ $/, '');
              }
      
              prevText = null;
              prevVoid = false;
            } else if (isVoid(node)) {
              // Avoid trimming space around non-block, non-BR void elements.
              prevText = null;
              prevVoid = true;
            }
          } else {
            node = remove(node);
            continue;
          }
      
          const nextNode = next(prev, node, isPre);
          prev = node;
          node = nextNode;
        }
      
        if (prevText) {
          prevText.data = prevText.data.replace(/ $/, '');
          if (!prevText.data) {
            remove(prevText);
          }
        }
      }
      
      /**
       * remove(node) removes the given node from the DOM and returns the
       * next node in the sequence.
       *
       * @param {Node} node
       * @return {Node} node
       */
      function remove(node) {
        const next = node.nextSibling || node.parentNode;
      
        node.parentNode.removeChild(node);
      
        return next;
      }
      
      /**
       * next(prev, current, isPre) returns the next node in the sequence, given the
       * current and previous nodes.
       *
       * @param {Node} prev
       * @param {Node} current
       * @param {Function} isPre
       * @return {Node}
       */
      function next(prev, current, isPre) {
        if ((prev && prev.parentNode === current) || isPre(current)) {
          return current.nextSibling || current.parentNode;
        }
      
        return current.firstChild || current.nextSibling || current.parentNode;
      }
      
      /*
       * Set up window for Node.js
       */
      
      const root = typeof window !== 'undefined' ? window : {};
      
      /*
       * Parsing HTML strings
       */
      
      function canParseHTMLNatively() {
        const Parser = root.DOMParser;
        let canParse = false;
      
        // Adapted from https://gist.github.com/1129031
        // Firefox/Opera/IE throw errors on unsupported types
        try {
          // WebKit returns null on unsupported types
          if (new Parser().parseFromString('', 'text/html')) {
            canParse = true;
          }
        } catch (e) {}
      
        return canParse;
      }
      
      function createHTMLParser() {
        const Parser = function () {};
      
        {
          const JSDOM = require('jsdom').JSDOM;
          Parser.prototype.parseFromString = function (string) {
            return new JSDOM(string).window.document;
          };
        }
        return Parser;
      }
      
      const HTMLParser = canParseHTMLNatively() ? root.DOMParser : createHTMLParser();
      
      function RootNode(input) {
        let root;
        if (typeof input === 'string') {
          const doc = htmlParser().parseFromString(
            // DOM parsers arrange elements in the <head> and <body>.
            // Wrapping in a custom element ensures elements are reliably arranged in
            // a single element.
            '<x-turndown id="turndown-root">' + input + '</x-turndown>',
            'text/html',
          );
      
          root = doc.getElementById('turndown-root');
        } else {
          root = input.cloneNode(true);
        }
        collapseWhitespace({
          element: root,
          isBlock: isBlock,
          isVoid: isVoid,
        });
      
        return root;
      }
      
      let _htmlParser;
      function htmlParser() {
        _htmlParser = _htmlParser || new HTMLParser();
        return _htmlParser;
      }
      
      function Node(node) {
        node.isBlock = isBlock(node);
        node.isCode =
          node.nodeName.toLowerCase() === 'code' || node.parentNode.isCode;
        node.isBlank = isBlank(node);
        node.flankingWhitespace = flankingWhitespace(node);
        return node;
      }
      
      function isBlank(node) {
        return (
          ['A', 'TH', 'TD', 'IFRAME', 'SCRIPT', 'AUDIO', 'VIDEO'].indexOf(
            node.nodeName,
          ) === -1 &&
          /^\s*$/i.test(node.textContent) &&
          !isVoid(node) &&
          !hasVoid(node)
        );
      }
      
      function flankingWhitespace(node) {
        let leading = '';
        let trailing = '';
      
        if (!node.isBlock) {
          const hasLeading = /^\s/.test(node.textContent);
          const hasTrailing = /\s$/.test(node.textContent);
          const blankWithSpaces = node.isBlank && hasLeading && hasTrailing;
      
          if (hasLeading && !isFlankedByWhitespace('left', node)) {
            leading = ' ';
          }
      
          if (
            !blankWithSpaces &&
            hasTrailing &&
            !isFlankedByWhitespace('right', node)
          ) {
            trailing = ' ';
          }
        }
      
        return {leading: leading, trailing: trailing};
      }
      
      function isFlankedByWhitespace(side, node) {
        let sibling;
        let regExp;
        let isFlanked;
      
        if (side === 'left') {
          sibling = node.previousSibling;
          regExp = / $/;
        } else {
          sibling = node.nextSibling;
          regExp = /^ /;
        }
      
        if (sibling) {
          if (sibling.nodeType === 3) {
            isFlanked = regExp.test(sibling.nodeValue);
          } else if (sibling.nodeType === 1 && !isBlock(sibling)) {
            isFlanked = regExp.test(sibling.textContent);
          }
        }
        return isFlanked;
      }
      
      const reduce = Array.prototype.reduce;
      const leadingNewLinesRegExp = /^\n*/;
      const trailingNewLinesRegExp = /\n*$/;
      const escapes = [
        [/\\/g, '\\\\'],
        [/\*/g, '\\*'],
        [/^-/g, '\\-'],
        [/^\+ /g, '\\+ '],
        [/^(=+)/g, '\\$1'],
        [/^(#{1,6}) /g, '\\$1 '],
        [/`/g, '\\`'],
        [/^~~~/g, '\\~~~'],
        [/\[/g, '\\['],
        [/\]/g, '\\]'],
        [/^>/g, '\\>'],
        [/_/g, '\\_'],
        [/^(\d+)\. /g, '$1\\. '],
      ];
      
      function TurndownService(options) {
        if (!(this instanceof TurndownService)) return new TurndownService(options);
      
        const defaults = {
          rules: rules,
          headingStyle: 'setext',
          hr: '* * *',
          bulletListMarker: '*',
          codeBlockStyle: 'indented',
          fence: '```',
          emDelimiter: '_',
          strongDelimiter: '**',
          linkStyle: 'inlined',
          linkReferenceStyle: 'full',
          br: '  ',
          blankReplacement: function (content, node) {
            return node.isBlock ? '\n\n' : '';
          },
          keepReplacement: function (content, node) {
            return node.isBlock ? '\n\n' + node.outerHTML + '\n\n' : node.outerHTML;
          },
          defaultReplacement: function (content, node) {
            return node.isBlock ? '\n\n' + content + '\n\n' : content;
          },
        };
      
        this.options = extend({}, defaults, options);
        this.rules = new Rules(this.options);
      }
      
      TurndownService.prototype = {
        /**
         * The entry point for converting a string or DOM node to Markdown
         * @public
         * @param {String|HTMLElement} input The string or DOM node to convert
         * @returns A Markdown representation of the input
         * @type String
         */
      
        turndown: function (input) {
          if (!canConvert(input)) {
            throw new TypeError(
              input + ' is not a string, or an element/document/fragment node.',
            );
          }
      
          if (input === '') return '';
      
          const output = process.call(this, new RootNode(input));
          return postProcess.call(this, output);
        },
      
        /**
         * Add one or more plugins
         * @public
         * @param {Function|Array} plugin The plugin or array of plugins to add
         * @returns The Turndown instance for chaining
         * @type Object
         */
      
        use: function (plugin) {
          if (Array.isArray(plugin)) {
            for (let i = 0; i < plugin.length; i++) this.use(plugin[i]);
          } else if (typeof plugin === 'function') {
            plugin(this);
          } else {
            throw new TypeError('plugin must be a Function or an Array of Functions');
          }
          return this;
        },
      
        /**
         * Adds a rule
         * @public
         * @param {String} key The unique key of the rule
         * @param {Object} rule The rule
         * @returns The Turndown instance for chaining
         * @type Object
         */
      
        addRule: function (key, rule) {
          this.rules.add(key, rule);
          return this;
        },
      
        /**
         * Keep a node (as HTML) that matches the filter
         * @public
         * @param {String|Array|Function} filter The unique key of the rule
         * @returns The Turndown instance for chaining
         * @type Object
         */
      
        keep: function (filter) {
          this.rules.keep(filter);
          return this;
        },
      
        /**
         * Remove a node that matches the filter
         * @public
         * @param {String|Array|Function} filter The unique key of the rule
         * @returns The Turndown instance for chaining
         * @type Object
         */
      
        remove: function (filter) {
          this.rules.remove(filter);
          return this;
        },
      
        /**
         * Escapes Markdown syntax
         * @public
         * @param {String} string The string to escape
         * @returns A string with Markdown syntax escaped
         * @type String
         */
      
        escape: function (string) {
          return escapes.reduce(function (accumulator, escape) {
            return accumulator.replace(escape[0], escape[1]);
          }, string);
        },
      };
      
      /**
       * Reduces a DOM node down to its Markdown string equivalent
       * @private
       * @param {HTMLElement} parentNode The node to convert
       * @returns A Markdown representation of the node
       * @type String
       */
      
      function process(parentNode) {
        const self = this;
        return reduce.call(
          parentNode.childNodes,
          function (output, node) {
            node = new Node(node);
      
            let replacement = '';
            if (node.nodeType === 3) {
              replacement = node.isCode
                ? node.nodeValue
                : self.escape(node.nodeValue);
            } else if (node.nodeType === 1) {
              replacement = replacementForNode.call(self, node);
            }
      
            return join(output, replacement);
          },
          '',
        );
      }
      
      /**
       * Appends strings as each rule requires and trims the output
       * @private
       * @param {String} output The conversion output
       * @returns A trimmed version of the ouput
       * @type String
       */
      
      function postProcess(output) {
        const self = this;
        this.rules.forEach(function (rule) {
          if (typeof rule.append === 'function') {
            output = join(output, rule.append(self.options));
          }
        });
      
        return output.replace(/^[\t\r\n]+/, '').replace(/[\t\r\n\s]+$/, '');
      }
      
      /**
       * Converts an element node to its Markdown equivalent
       * @private
       * @param {HTMLElement} node The node to convert
       * @returns A Markdown representation of the node
       * @type String
       */
      
      function replacementForNode(node) {
        const rule = this.rules.forNode(node);
        let content = process.call(this, node);
        const whitespace = node.flankingWhitespace;
        if (whitespace.leading || whitespace.trailing) content = content.trim();
        return (
          whitespace.leading +
          rule.replacement(content, node, this.options) +
          whitespace.trailing
        );
      }
      
      /**
       * Determines the new lines between the current output and the replacement
       * @private
       * @param {String} output The current conversion output
       * @param {String} replacement The string to append to the output
       * @returns The whitespace to separate the current output and the replacement
       * @type String
       */
      
      function separatingNewlines(output, replacement) {
        const newlines = [
          output.match(trailingNewLinesRegExp)[0],
          replacement.match(leadingNewLinesRegExp)[0],
        ].sort();
        const maxNewlines = newlines[newlines.length - 1];
        return maxNewlines.length < 2 ? maxNewlines : '\n\n';
      }
      
      function join(string1, string2) {
        const separator = separatingNewlines(string1, string2);
      
        // Remove trailing/leading newlines and replace with separator
        string1 = string1.replace(trailingNewLinesRegExp, '');
        string2 = string2.replace(leadingNewLinesRegExp, '');
      
        return string1 + separator + string2;
      }
      
      /**
       * Determines whether an input can be converted
       * @private
       * @param {String|HTMLElement} input Describe this parameter
       * @returns Describe what it returns
       * @type String|Object|Array|Boolean|Number
       */
      
      function canConvert(input) {
        return (
          input != null &&
          (typeof input === 'string' ||
            (input.nodeType &&
              (input.nodeType === 1 ||
                input.nodeType === 9 ||
                input.nodeType === 11)))
        );
      }
      return TurndownService;
    })();
    // --- End Modules ---
  
    // --- Main Logic ---
   
    const {title, content} = new Readability(document.cloneNode(true)).parse();
    const fileName = title.replace(/[^a-zA-Z0-9]/g, '').substring(0, 24);
  
    let markdownify = content;
    const markdownBody = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      // Disable image conversion to keep images separate
      // in the `images` array
      rules: {
        image: {
          filter: 'img',
          replacement: function() {
            return ''; // Remove any image markdown
          }
        }
      }
    }).turndown(markdownify);
  
    const imageUrls = [];
    const imgElements = document.querySelectorAll('img, video, audio');
    imgElements.forEach(elem => {
      const src = elem.getAttribute('src');
      if (src) {
        imageUrls.push(src); 
      }
    });
  
    // // Build the .md content
    // let mdContent = `---\ntitle: ${title.replace(/[^a-zA-Z0-9 ]/g, ' - ').substring(0, 240)}\n---\n### ${title}\n${document.URL}\n\n${markdownBody}\n\n`;
    // imageUrls.forEach(imageUrl => {
    //   mdContent += `![](${imageUrl})\n\n`; 
    // });
  
    const data = {
      title: title,
      source: document.URL,
      content: markdownBody, // Content now clean of image embeds
      images: imageUrls
    };
  
    // Create the JSON data string
    const dataString = encodeURIComponent(JSON.stringify(data));
    const jsonDownloadLink = `data:application/json;charset=utf-8,${dataString}`;
  
    // // Create the Markdown data string
    // const mdDownloadLink = `data:text/markdown;charset=utf-8,${encodeURIComponent(mdContent)}`;
  
    // Inject links that trigger the downloads
    const jsonLink = document.createElement('a');
    jsonLink.href = jsonDownloadLink;
    jsonLink.download = `${fileName}.json`;
    jsonLink.click();
  
    // const mdLink = document.createElement('a');
    // mdLink.href = mdDownloadLink;
    // mdLink.download = `${fileName}.md`;
    // mdLink.click();
  })();