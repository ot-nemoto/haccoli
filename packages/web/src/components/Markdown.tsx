import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown 表示。React 要素として描画し innerHTML は使わない。
 * 生の HTML は描画せず（skipHtml）、javascript: 等の危険な URL は react-markdown が除去する。
 */
export function Markdown(props: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _node, ...rest }) => (
            <a {...rest} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {props.children}
      </ReactMarkdown>
    </div>
  );
}
