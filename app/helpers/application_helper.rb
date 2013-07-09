module ApplicationHelper

	def yes_or_no(b)
		b ? 'Yes' : 'No'
	end

	def text_with_icon(text, icon)
		"<i class=\"icon-white icon-#{icon}\"></i> #{text}".html_safe
	end

end
